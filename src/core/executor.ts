import type { AdapterSet } from "@/adapters/types";
import type { Action, ActionContext, ApplyResult, Check, CheckResult } from "@/core/action";
import { IrreversibleError, UnverifiableError } from "@/core/action";
import { RateLimitError } from "@/adapters/faults";
import { materialize, type PlanDecision, type BuildContext } from "@/actions/index";
import { validateOrdering, type OrderingViolation } from "@/core/ordering";
import { remediationsFor, type VerificationFailure } from "@/core/remediate";
import { applyMutation } from "@/eval/mutate";
import { discover, type Discovery } from "@/core/discover";
import { goalChecks } from "@/core/goals";
import type { Tracer } from "@/core/trace";
import type { Grant } from "@/core/world";
import { describeGrantPath } from "@/core/world";

export type Planner = (input: {
  discovery: Discovery;
  violations?: OrderingViolation[];
  previous?: PlanDecision[];
}) => Promise<{ decisions: PlanDecision[]; summary: string }>;

export type Approver = (pending: Action[]) => Promise<Set<string>>;

export type CheckRecord = { checkId: string; describe: string; result: CheckResult };

export type RehearsalEntry = {
  actionId: string;
  description: string;
  app: string;
  kind: string;
  reversible: boolean;
  preconditions: CheckRecord[];
  applied: ApplyResult | null;
  postconditions: CheckRecord[];
  ok: boolean;
  error?: string;
};

export type RehearsalReport = {
  before: Grant[];
  after: Grant[];
  removed: Grant[];
  remaining: Grant[];
  entries: RehearsalEntry[];
};

export type CommitEntry = {
  actionId: string;
  description: string;
  idempotencyKey: string;
  status: "applied" | "skipped-idempotent" | "precondition-failed" | "failed" | "not-attempted";
  applied?: ApplyResult;
  preconditions?: CheckRecord[];
  error?: string;
};

export type RunStatus = "verified" | "unresolved" | "rolled-back" | "rejected" | "failed";

export type RunResult = {
  runId: string;
  status: RunStatus;
  summary: string;
  discovery: Discovery;
  decisions: PlanDecision[];
  rehearsal: RehearsalReport | null;
  approvals: { required: string[]; granted: string[] };
  commits: CommitEntry[];
  verification: { checks: (CheckRecord & { actionId: string })[]; failures: VerificationFailure[] };
  remediationRounds: number;
  rollback?: { attempted: string[]; succeeded: string[]; failed: { id: string; error: string }[]; irreversibleLeftInPlace: string[] };
  tokens: { input: number; output: number };
  costUsd: number;
  durationMs: number;
};

export type ExecuteOptions = {
  runId: string;
  tracer: Tracer;
  build: BuildContext;
  live: AdapterSet;
  /** A fresh shadow adapter set over a world seeded from live. */
  shadow: AdapterSet;
  planner: Planner;
  approver: Approver;
  completedKeys?: Set<string>;
  maxRemediationRounds?: number;
  /** Demo switch: skip verify entirely, to prove the trace judge notices. */
  skipVerify?: boolean;
};

const MAX_RATE_LIMIT_RETRIES = 3;

async function withBackoff<T>(tracer: Tracer, label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RateLimitError && attempt < MAX_RATE_LIMIT_RETRIES) {
        // Deterministic, capped backoff. Sleeping the full Retry-After would make
        // the eval suite slow for no extra signal, so it is clamped in shadow.
        const waitMs = Math.min(err.retryAfterMs, 50);
        tracer.emit({ type: "note", label: `${label}:rate-limited`, detail: { attempt: attempt + 1, waitMs } });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

async function runChecks(checks: Check[], adapters: AdapterSet, tracer: Tracer, kind: "precondition" | "postcondition", actionId: string, phase: "rehearse" | "commit" | "verify"): Promise<CheckRecord[]> {
  const out: CheckRecord[] = [];
  for (const c of checks) {
    const t0 = Date.now();
    let result: CheckResult;
    try {
      result = await c.run({ adapters });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const unverifiable = err instanceof UnverifiableError;
      result = {
        pass: false, observed: null, unverifiable,
        note: unverifiable ? `could not verify: ${msg}` : `check threw: ${msg}`,
      };
    }
    // Mutation testing seam. Inert unless the eval explicitly injects a mutant;
    // see src/eval/mutate.ts for why an eval that cannot fail measures nothing.
    result = applyMutation(c.id, result);
    tracer.emit({
      type: kind, phase, actionId, checkId: c.id, label: c.describe,
      ok: result.pass, observed: result.observed, detail: result.note ? { note: result.note } : undefined,
      durationMs: Date.now() - t0,
    });
    out.push({ checkId: c.id, describe: c.describe, result });
  }
  return out;
}

export async function execute(opts: ExecuteOptions): Promise<RunResult> {
  const started = Date.now();
  const { tracer, live, shadow, build } = opts;
  const completedKeys = opts.completedKeys ?? new Set<string>();
  const maxRounds = opts.maxRemediationRounds ?? 2;

  // ---------------------------------------------------------------- 1. discover
  const discovery = await discover(live, build.target, build.org, tracer);

  // ---------------------------------------------------------------- 2. plan
  tracer.emit({ type: "phase", phase: "plan", label: "plan:start" });
  let planned: { decisions: PlanDecision[]; summary: string };
  try {
    planned = await opts.planner({ discovery });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    tracer.emit({ type: "phase", phase: "plan", label: "plan:failed", ok: false, detail: { error: msg } });
    return baseResult("rejected", `Planning failed: ${msg}`);
  }
  let actions = materialize(planned.decisions, build);
  let violations = validateOrdering(actions);

  if (violations.length) {
    // Do not fix the model's ordering silently: send the violation back and make
    // it re-plan, so the trace records that the invariant did work.
    tracer.emit({ type: "note", phase: "plan", label: "plan:ordering-rejected", ok: false, detail: violations });
    planned = await opts.planner({ discovery, violations, previous: planned.decisions });
    actions = materialize(planned.decisions, build);
    violations = validateOrdering(actions);
    if (violations.length) {
      tracer.emit({ type: "phase", phase: "plan", label: "plan:failed", ok: false, detail: violations });
      return baseResult("rejected", "Plan violates transfer-before-revoke ordering after re-planning.");
    }
  }
  tracer.emit({ type: "phase", phase: "plan", label: "plan:done", detail: { actions: actions.length, summary: planned.summary } });

  // An empty plan is only legitimate when discovery found nothing to act on.
  // Otherwise the agent has produced a confident narrative over zero actions,
  // which is the exact failure this system exists to refuse.
  if (actions.length === 0 && discoveryHasWork(discovery)) {
    tracer.emit({
      type: "phase", phase: "plan", label: "plan:empty", ok: false,
      detail: {
        githubGrants: discovery.github.grants.length,
        driveFiles: discovery.drive.files.length,
        linearIssues: discovery.linear.issues.length,
      },
    });
    return baseResult(
      "rejected",
      "The plan contained no actions while discovery found access to close. Refusing to report a clean offboarding over an empty plan.",
    );
  }

  // ---------------------------------------------------------------- 3. rehearse
  tracer.emit({ type: "phase", phase: "rehearse", label: "rehearse:start" });
  const before = await discover(shadow, build.target, build.org, tracer);
  const entries: RehearsalEntry[] = [];
  for (const a of actions) {
    const pre = await runChecks(a.preconditions, shadow, tracer, "precondition", a.id, "rehearse");
    const entry: RehearsalEntry = {
      actionId: a.id, description: a.description, app: a.app, kind: a.kind, reversible: a.reversible,
      preconditions: pre, applied: null, postconditions: [], ok: false,
    };
    if (pre.some((p) => !p.result.pass)) {
      entry.error = "precondition failed in rehearsal";
      entries.push(entry);
      continue;
    }
    try {
      entry.applied = await a.apply({ adapters: shadow, tracer });
      entry.postconditions = await runChecks(a.postconditions, shadow, tracer, "postcondition", a.id, "rehearse");
      entry.ok = entry.postconditions.every((p) => p.result.pass);
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    }
    entries.push(entry);
  }
  const after = await discover(shadow, build.target, build.org, tracer);
  const rehearsal: RehearsalReport = {
    before: before.github.grants, after: after.github.grants,
    removed: diffGrants(before.github.grants, after.github.grants),
    remaining: after.github.grants,
    entries,
  };
  tracer.emit({
    type: "phase", phase: "rehearse", label: "rehearse:done",
    detail: { removed: rehearsal.removed.length, remaining: rehearsal.remaining.length,
              failedInRehearsal: entries.filter((e) => !e.ok).map((e) => e.actionId) },
  });

  // ---------------------------------------------------------------- 4. approve
  const needsApproval = actions.filter((a) => !a.reversible);
  tracer.emit({
    type: "phase", phase: "approve", label: "approve:start",
    detail: { required: needsApproval.map((a) => ({ id: a.id, description: a.description })) },
  });
  const granted = needsApproval.length ? await opts.approver(needsApproval) : new Set<string>();
  const approvals = { required: needsApproval.map((a) => a.id), granted: [...granted] };
  const blocked = needsApproval.filter((a) => !granted.has(a.id)).map((a) => a.id);
  if (blocked.length) {
    tracer.emit({ type: "phase", phase: "approve", label: "approve:withheld", detail: { blocked } });
  }
  const toCommit = actions.filter((a) => a.reversible || granted.has(a.id));

  // ---------------------------------------------------------------- 5. commit
  const commits: CommitEntry[] = [];
  const completed: Action[] = [];
  let rollback: RunResult["rollback"];

  tracer.emit({ type: "phase", phase: "commit", label: "commit:start", detail: { count: toCommit.length } });

  for (const a of toCommit) {
    const ctx: ActionContext = { adapters: live, tracer };

    // A seen key skips the write outright.
    //
    // I tried making the skip conditional on live state, so a world that moved
    // underneath us (a re-seeded fixture, a re-issued grant) would be re-acted on.
    // It backfired: preconditions are not uniformly "is this outstanding" checks —
    // `driveFileExists` passes whether or not the permission was already removed —
    // so the heuristic re-applied six actions that were genuinely complete.
    //
    // The simple rule is safe here for a specific reason: verification is
    // goal-based. The goal checks in verify re-read every access path DISCOVERY
    // found, independently of what the plan did or skipped, so a skip that was
    // wrong surfaces as surviving access rather than as a clean report. Correctness
    // does not rest on the key being right; it rests on the re-read.
    if (completedKeys.has(a.idempotencyKey)) {
      commits.push({ actionId: a.id, description: a.description, idempotencyKey: a.idempotencyKey, status: "skipped-idempotent" });
      tracer.emit({ type: "action", phase: "commit", actionId: a.id, label: "commit:skipped-idempotent", ok: true, detail: { key: a.idempotencyKey } });
      continue;
    }

    const pre = await runChecks(a.preconditions, live, tracer, "precondition", a.id, "commit");
    if (pre.some((p) => !p.result.pass)) {
      commits.push({ actionId: a.id, description: a.description, idempotencyKey: a.idempotencyKey, status: "precondition-failed", preconditions: pre });
      tracer.emit({ type: "action", phase: "commit", actionId: a.id, label: "commit:precondition-failed", ok: false });
      continue;
    }

    try {
      // The key is recorded BEFORE the call. A crash between the write and the
      // record would otherwise replay the write on resume.
      completedKeys.add(a.idempotencyKey);
      const applied = await withBackoff(tracer, a.id, () => a.apply(ctx));
      // Not every failed write throws. Slack answers 200 with ok:false, which the
      // adapter maps to 400 — and this recorded it as "applied" with a cheerful
      // green 400 next to it. A write is applied when the API says it succeeded,
      // not when the call returned.
      if (applied.status >= 300) {
        throw new Error(`write returned ${applied.status}: ${JSON.stringify(applied.body).slice(0, 200)}`);
      }
      commits.push({ actionId: a.id, description: a.description, idempotencyKey: a.idempotencyKey, status: "applied", applied, preconditions: pre });
      completed.push(a);
      tracer.emit({
        type: "action", phase: "commit", actionId: a.id, label: `commit:applied ${a.description}`,
        ok: true, detail: { status: applied.status, idempotencyKey: a.idempotencyKey },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      completedKeys.delete(a.idempotencyKey);
      commits.push({ actionId: a.id, description: a.description, idempotencyKey: a.idempotencyKey, status: "failed", error: msg });
      tracer.emit({ type: "action", phase: "commit", actionId: a.id, label: "commit:failed", ok: false, detail: { error: msg } });

      // A notification that fails is not a reason to re-grant access.
      //
      // Rolling back a completed set of revocations because a Slack post 404'd
      // would hand the departing employee their access back to fix a reporting
      // problem — strictly worse than the problem. Notify actions are recorded as
      // failed, the run continues, and the run ends `unresolved` so the failure is
      // reported rather than buried.
      if (a.kind === "notify") {
        tracer.emit({
          type: "note", phase: "commit", actionId: a.id, label: "commit:notify-failed-continuing", ok: false,
          detail: { reason: "a failed notification does not justify undoing completed revocations", error: msg },
        });
        continue;
      }

      rollback = await rollbackAll(completed, { adapters: live, tracer }, tracer);
      for (const a2 of toCommit) {
        if (!commits.some((c) => c.actionId === a2.id)) {
          commits.push({ actionId: a2.id, description: a2.description, idempotencyKey: a2.idempotencyKey, status: "not-attempted" });
        }
      }
      const result = baseResult("rolled-back", `Commit failed on ${a.id}: ${msg}. Completed actions were rolled back in reverse order.`);
      result.commits = commits;
      result.rollback = rollback;
      result.rehearsal = rehearsal;
      result.approvals = approvals;
      result.decisions = planned.decisions;
      return result;
    }
  }
  tracer.emit({ type: "phase", phase: "commit", label: "commit:done", detail: { applied: completed.length } });

  // ---------------------------------------------------------------- 6. verify
  const allChecks: (CheckRecord & { actionId: string })[] = [];
  let failures: VerificationFailure[] = [];
  let rounds = 0;

  if (opts.skipVerify) {
    tracer.emit({ type: "phase", phase: "verify", label: "verify:skipped", ok: false, detail: { reason: "skipVerify flag set (demo)" } });
  } else {
    let pending = completed;
    // Derived from discovery, so they hold whether or not the plan addressed the
    // resource. Evaluated every round alongside the actions' own postconditions.
    const goals = goalChecks(discovery);
    tracer.emit({ type: "note", phase: "verify", label: "verify:goal-checks", detail: { count: goals.length } });

    for (;;) {
      tracer.emit({ type: "phase", phase: "verify", label: `verify:start round=${rounds}` });
      failures = [];

      // Several actions on the same resource share a postcondition — removing a
      // user permission and removing a link-sharing permission on one file both
      // ask "does this person still have access to it" — and a goal check asks the
      // same question again. Each distinct question is worth one API call and one
      // line of output per round.
      const askedThisRound = new Set<string>();
      const coveredByActions = new Set(pending.flatMap((a) => a.postconditions.map((c) => c.id)));
      const uncoveredGoals = goals.filter((g) => !coveredByActions.has(g.id));
      if (uncoveredGoals.length) {
        tracer.emit({
          type: "note", phase: "verify", label: "verify:goals-not-covered-by-any-action",
          detail: { checks: uncoveredGoals.map((g) => g.id) },
        });
      }

      for (const g of uncoveredGoals) {
        if (askedThisRound.has(g.id)) continue;
        askedThisRound.add(g.id);
        const [rec] = await runChecks([g], live, tracer, "postcondition", "goal", "verify");
        allChecks.push({ ...rec, actionId: "goal" });
        if (!rec.result.pass && !rec.result.unverifiable) {
          failures.push({ actionId: "goal", checkId: rec.checkId, describe: rec.describe, result: rec.result });
        }
      }

      for (const a of pending) {
        const fresh = a.postconditions.filter((c) => !askedThisRound.has(c.id));
        for (const c of fresh) askedThisRound.add(c.id);
        const recs = await runChecks(fresh, live, tracer, "postcondition", a.id, "verify");
        for (const r of recs) {
          allChecks.push({ ...r, actionId: a.id });
          // An unverifiable check is not a detected failure, so it does not feed
          // remediation — there is nothing to remediate. It does block `verified`.
          if (!r.result.pass && !r.result.unverifiable) {
            failures.push({ actionId: a.id, checkId: r.checkId, describe: r.describe, result: r.result });
          }
        }
      }
      tracer.emit({
        type: "phase", phase: "verify", label: `verify:done round=${rounds}`,
        ok: failures.length === 0,
        detail: { failures: failures.map((f) => ({ checkId: f.checkId, note: f.result.note, observed: f.result.observed })) },
      });

      if (!failures.length) break;
      if (rounds >= maxRounds) {
        tracer.emit({ type: "phase", phase: "verify", label: "verify:exhausted", ok: false, detail: { rounds, remaining: failures.length } });
        break;
      }

      // Remediate and re-enter commit.
      const decisions = failures.flatMap((f) =>
        remediationsFor(f, { org: build.org, login: build.target.githubLogin, email: build.target.email }),
      );
      if (!decisions.length) {
        tracer.emit({ type: "phase", phase: "verify", label: "verify:no-remediation", ok: false, detail: { failures: failures.map((f) => f.checkId) } });
        break;
      }
      tracer.emit({ type: "remediation", phase: "verify", label: "remediation:planned", detail: decisions.map((d) => ({ id: d.id, operation: d.operation, rationale: d.rationale })) });

      const remActions = materialize(decisions, build);
      const remNeedingApproval = remActions.filter((a) => !a.reversible);
      const remGranted = remNeedingApproval.length ? await opts.approver(remNeedingApproval) : new Set<string>();
      approvals.required.push(...remNeedingApproval.map((a) => a.id));
      approvals.granted.push(...remGranted);

      const remToCommit = remActions.filter((a) => a.reversible || remGranted.has(a.id));
      const applied: Action[] = [];
      for (const a of remToCommit) {
        if (completedKeys.has(a.idempotencyKey)) continue;
        try {
          completedKeys.add(a.idempotencyKey);
          const res = await withBackoff(tracer, a.id, () => a.apply({ adapters: live, tracer }));
          commits.push({ actionId: a.id, description: a.description, idempotencyKey: a.idempotencyKey, status: "applied", applied: res });
          applied.push(a);
          completed.push(a);
          tracer.emit({ type: "remediation", phase: "commit", actionId: a.id, label: `remediation:applied ${a.description}`, ok: true, detail: { status: res.status } });
        } catch (err) {
          completedKeys.delete(a.idempotencyKey);
          const msg = err instanceof Error ? err.message : String(err);
          commits.push({ actionId: a.id, description: a.description, idempotencyKey: a.idempotencyKey, status: "failed", error: msg });
          tracer.emit({ type: "remediation", phase: "commit", actionId: a.id, label: "remediation:failed", ok: false, detail: { error: msg } });
        }
      }

      // Re-verify the actions that failed plus whatever the remediation touched.
      const failedActionIds = new Set(failures.map((f) => f.actionId));
      pending = [...pending.filter((a) => failedActionIds.has(a.id)), ...applied];
      rounds++;
      if (!applied.length) break;
    }
  }

  // A planned action that never ran is an open loop, not a success. Preconditions
  // that refused, writes that failed, and approvals that were withheld all leave
  // the world short of the plan, and reporting "verified" over any of them would
  // be exactly the kind of confident, wrong summary this system exists to prevent.
  const notRun = commits.filter((c) => c.status === "precondition-failed" || c.status === "failed");
  // Committed work that nothing confirmed is unverified by definition, whatever
  // the absence of failures might suggest.
  const unconfirmed = completed.length > 0 && allChecks.length === 0;
  const unverifiable = allChecks.filter((c) => c.result.unverifiable);
  const incomplete = notRun.length > 0 || blocked.length > 0 || unconfirmed || unverifiable.length > 0;

  const status: RunStatus =
    opts.skipVerify || failures.length || incomplete ? "unresolved" : "verified";

  const summary = opts.skipVerify
    ? "Verification was skipped. Nothing about this run has been independently confirmed."
    : failures.length
      ? `${failures.length} postcondition(s) still failing after ${rounds} remediation round(s). Access may persist.`
      : unconfirmed
        ? `${completed.length} action(s) were committed and NONE were independently confirmed. Nothing here is verified.`
        : unverifiable.length
        ? `${allChecks.length - unverifiable.length} postcondition(s) confirmed, but ${unverifiable.length} could not be ` +
          `read back at all (${[...new Set(unverifiable.map((c) => c.result.note))].join("; ")}). Unknown is not success.`
        : incomplete
        ? `All ${allChecks.length} evaluated postconditions passed, but ${notRun.length} planned action(s) did not run` +
          `${blocked.length ? ` and ${blocked.length} await approval` : ""}. The plan is not complete.`
        : `All ${allChecks.length} postconditions independently re-read and passed.`;

  const result = baseResult(status, summary);
  result.rehearsal = rehearsal;
  result.approvals = approvals;
  result.commits = commits;
  result.decisions = planned.decisions;
  result.verification = { checks: allChecks, failures };
  result.remediationRounds = rounds;
  return result;

  function baseResult(status: RunStatus, summary: string): RunResult {
    const totals = tracer.totals();
    return {
      runId: opts.runId, status, summary, discovery,
      decisions: [], rehearsal: null,
      approvals: { required: [], granted: [] },
      commits: [], verification: { checks: [], failures: [] },
      remediationRounds: 0,
      tokens: { input: totals.input, output: totals.output },
      costUsd: totals.costUsd,
      durationMs: Date.now() - started,
    };
  }
}

async function rollbackAll(completed: Action[], ctx: ActionContext, tracer: Tracer) {
  const attempted: string[] = [], succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const irreversibleLeftInPlace: string[] = [];

  tracer.emit({ type: "rollback", phase: "commit", label: "rollback:start", detail: { count: completed.length } });

  for (const a of [...completed].reverse()) {
    if (!a.reversible) {
      // Honest about the limit: an approved irreversible action cannot be undone by
      // rollback. That is precisely why it required a human before it ran.
      irreversibleLeftInPlace.push(a.id);
      tracer.emit({ type: "rollback", phase: "commit", actionId: a.id, label: "rollback:irreversible-left-in-place", ok: false });
      continue;
    }
    attempted.push(a.id);
    try {
      await a.inverse(ctx);
      succeeded.push(a.id);
      tracer.emit({ type: "rollback", phase: "commit", actionId: a.id, label: `rollback:undone ${a.description}`, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof IrreversibleError) irreversibleLeftInPlace.push(a.id);
      failed.push({ id: a.id, error: msg });
      tracer.emit({ type: "rollback", phase: "commit", actionId: a.id, label: "rollback:failed", ok: false, detail: { error: msg } });
    }
  }
  tracer.emit({ type: "rollback", phase: "commit", label: "rollback:done", ok: failed.length === 0, detail: { succeeded: succeeded.length, failed: failed.length, irreversibleLeftInPlace } });
  return { attempted, succeeded, failed, irreversibleLeftInPlace };
}

function discoveryHasWork(d: Discovery): boolean {
  return (
    d.github.grants.length > 0 ||
    d.drive.files.length > 0 ||
    d.linear.issues.length > 0 ||
    d.linear.memberships.length > 0
  );
}

function diffGrants(before: Grant[], after: Grant[]): Grant[] {
  const key = (g: Grant) => `${g.resourceId}|${g.permission}|${describeGrantPath(g.path)}`;
  const afterKeys = new Set(after.map(key));
  return before.filter((g) => !afterKeys.has(key(g)));
}
