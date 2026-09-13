import { adapterSet } from "@/adapters/registry";
import { execute, type RunResult, type Planner } from "@/core/executor";
import { Tracer } from "@/core/trace";
import { cloneWorld, type WorldState } from "@/core/world";
import { evaluate, type AssertionResult } from "@/eval/oracle";
import type { Scenario } from "@/eval/types";
import type { Action } from "@/core/action";

export type ScenarioRun = {
  scenario: Scenario;
  result: RunResult;
  oracle: AssertionResult[];
  initialWorld: WorldState;
  finalWorld: WorldState;
  /** The agent told us everything verified. */
  claimedSuccess: boolean;
  /** Independent ground truth agrees the end state is correct. */
  groundTruthOk: boolean;
  /** Claimed success and ground truth disagrees. The headline failure. */
  silentFailure: boolean;
  /** Postconditions that failed during verify — access the system caught itself. */
  caughtInVerify: number;
  blockedByDesign: number;
  verifyFailures: number;
  taskSuccess: boolean;
  rollbackCorrect: boolean | null;
  durationMs: number;
  costUsd: number;
  tracePath: string | null;
};

export async function runScenario(
  s: Scenario,
  makePlanner: (t: Tracer) => Planner,
  opts: { traceDir?: string; replay?: boolean } = {},
): Promise<ScenarioRun> {
  const initialWorld = cloneWorld(s.world);

  // The "live" world the oracle will judge. Shadow-backed so the suite is fast and
  // deterministic; the executor cannot tell, which is the point of the adapter split.
  const liveWorld = cloneWorld(s.world);
  const live = adapterSet("shadow", { world: liveWorld, faults: s.faults ?? [] });

  // A separate sandbox world for rehearsal, seeded from the same snapshot.
  const shadow = adapterSet("shadow", { world: cloneWorld(s.world) });

  const runId = `eval-${s.id}`;
  const tracer = new Tracer(runId, opts.traceDir ? { dir: opts.traceDir } : { memoryOnly: true });

  const approver = async (pending: Action[]) => {
    const ids = new Set<string>();
    if (s.approve === "all") for (const a of pending) ids.add(a.id);
    else if (Array.isArray(s.approve)) for (const a of pending) if (s.approve.includes(a.id)) ids.add(a.id);
    tracer.emit({
      type: "phase", phase: "approve", label: "approve:decision",
      detail: { policy: s.approve, granted: [...ids], withheld: pending.filter((a) => !ids.has(a.id)).map((a) => a.id) },
    });
    return ids;
  };

  const build = { org: s.world.github.org, target: s.target, slackChannel: s.slackChannel };
  const completedKeys = new Set<string>();

  let result = await execute({
    runId, tracer, build, live, shadow, planner: makePlanner(tracer), approver, completedKeys,
  });

  // Scenario 10: run it a second time with the same keys and assert nothing new is written.
  let replayWrites = 0;
  if (s.id.startsWith("10-")) {
    const before = liveWorld.slack.messages.length;
    const shadow2 = adapterSet("shadow", { world: cloneWorld(liveWorld) });
    const second = await execute({
      runId: `${runId}-replay`, tracer, build, live, shadow: shadow2,
      planner: makePlanner(tracer), approver, completedKeys,
    });
    replayWrites = second.commits.filter((c) => c.status === "applied").length;
    tracer.emit({
      type: "note", label: "idempotency:replay",
      ok: replayWrites === 0,
      detail: { newWrites: replayWrites, skipped: second.commits.filter((c) => c.status === "skipped-idempotent").length,
                slackMessagesBefore: before, slackMessagesAfter: liveWorld.slack.messages.length },
    });
    result = { ...result, summary: `${result.summary} Replay wrote ${replayWrites} new action(s).` };
  }

  tracer.close();

  const oracle = evaluate(s.expected.assertions, liveWorld, initialWorld);
  const groundTruthOk = oracle.every((o) => o.pass);
  const claimedSuccess = result.status === "verified";

  // A failing verify postcondition is not automatically a caught lie. When the
  // human withheld approval, the action never ran, so access surviving is the
  // system obeying the gate — counting that as a "silent failure caught" inflates
  // the headline with the opposite of a failure. A lie requires a write that
  // reported success and state that disagrees, so the action must have committed.
  const committedOk = new Set(
    tracer.events
      .filter((e) => e.type === "action" && e.phase === "commit" && e.ok === true && e.label.startsWith("commit:applied"))
      .map((e) => e.actionId)
      .filter((id): id is string => !!id),
  );
  const approvalWithheld = result.approvals.required.length > result.approvals.granted.length;

  const verifyFailures = tracer.events.filter(
    (e) => e.type === "postcondition" && e.phase === "verify" && e.ok === false,
  );
  // Goal-level checks are not tied to one action, so they only count as a caught
  // lie in a run where nothing was blocked by a withheld approval.
  const silentFailuresCaught = verifyFailures.filter((e) =>
    e.actionId && e.actionId !== "goal" ? committedOk.has(e.actionId) : !approvalWithheld,
  ).length;
  const blockedByDesign = verifyFailures.length - silentFailuresCaught;
  const caughtInVerify = silentFailuresCaught;

  const statusAsExpected = s.expected.expectRollback
    ? result.status === "rolled-back"
    : s.expected.expectUnresolved
      ? result.status === "unresolved"
      : result.status === "verified";

  const rollbackCorrect = s.expected.expectRollback
    ? oracle.find((o) => o.assertion.type === "world-unchanged")?.pass ?? false
    : null;

  const taskSuccess = groundTruthOk && statusAsExpected && (!s.id.startsWith("10-") || replayWrites === 0);

  return {
    scenario: s, result, oracle, initialWorld, finalWorld: liveWorld,
    claimedSuccess, groundTruthOk,
    silentFailure: claimedSuccess && !groundTruthOk,
    caughtInVerify, blockedByDesign, verifyFailures: verifyFailures.length,
    taskSuccess, rollbackCorrect,
    durationMs: result.durationMs, costUsd: result.costUsd,
    tracePath: opts.traceDir ? `${opts.traceDir}/${runId}.jsonl` : null,
  };
}
