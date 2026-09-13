import Link from "next/link";
import { notFound } from "next/navigation";
import { getRun, getEvents } from "@/core/db";
import { Badge, Panel, PanelHeader, Mono, Empty, PhaseNav, statusTone, PHASES, type Phase } from "@/app/ui";
import { describeGrantPath, type Grant } from "@/core/world";
import type { RunResult } from "@/core/executor";
import type { TraceEvent } from "@/core/trace";

export const dynamic = "force-dynamic";

export default async function RunPhase({ params }: { params: Promise<{ id: string; phase: string }> }) {
  const { id, phase } = await params;
  if (!PHASES.includes(phase as Phase)) notFound();

  let run: RunResult | null = null;
  let events: TraceEvent[] = [];
  try {
    run = getRun(id);
    events = getEvents(id);
  } catch {
    /* no db */
  }
  if (!run) notFound();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="mono text-[15px] font-medium">{run.runId}</h1>
        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
        <span className="text-dim">{run.summary}</span>
        <Link href={`/trace/${id}`} className="mono ml-auto text-[12px] text-accent hover:underline">
          trace ({events.length}) →
        </Link>
      </div>

      <div className="rounded-lg border border-line bg-panel px-2 py-1.5">
        <PhaseNav runId={id} active={phase} />
      </div>

      {phase === "discover" && <Discover run={run} />}
      {phase === "plan" && <PlanView run={run} />}
      {phase === "rehearse" && <Rehearse run={run} />}
      {phase === "approve" && <Approve run={run} />}
      {phase === "commit" && <Commit run={run} />}
      {phase === "verify" && <Verify run={run} events={events} />}
    </div>
  );
}

/* ---------------------------------------------------------------- discover */

function pathTone(p: string) {
  return p === "direct" ? "neutral" : "awaiting";
}

function GrantRow({ g }: { g: Grant }) {
  const path = describeGrantPath(g.path);
  return (
    <tr className="border-b border-linesoft/60 last:border-0">
      <td className="px-4 py-2"><Mono className="text-fg">{g.resourceName}</Mono></td>
      <td className="px-4 py-2"><Mono className="text-dim">{g.permission}</Mono></td>
      <td className="px-4 py-2"><Badge tone={pathTone(path)}>{path}</Badge></td>
    </tr>
  );
}

function Discover({ run }: { run: RunResult }) {
  const d = run.discovery;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel>
        <PanelHeader title={`github — ${d.github.grants.length} grants`} />
        {d.github.grants.length === 0 ? <Empty>no grants</Empty> : (
          <table className="w-full text-left">
            <thead><tr className="border-b border-linesoft text-[11px] uppercase tracking-[0.08em] text-faint">
              <th className="px-4 py-2 font-medium">resource</th><th className="px-4 py-2 font-medium">permission</th><th className="px-4 py-2 font-medium">grant path</th>
            </tr></thead>
            <tbody>{d.github.grants.map((g, i) => <GrantRow key={i} g={g} />)}</tbody>
          </table>
        )}
        <div className="border-t border-linesoft px-4 py-2 text-[11px] text-faint">
          the grant path is recorded, not just the grant — the permission endpoint cannot say which grant produced the answer
        </div>
      </Panel>

      <div className="space-y-4">
        <Panel>
          <PanelHeader title={`drive — ${d.drive.files.length} files`} />
          {d.drive.files.length === 0 ? <Empty>no files</Empty> : (
            <ul className="divide-y divide-linesoft/60">
              {d.drive.files.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                  <Mono className="text-fg">{f.id}</Mono>
                  <span className="text-dim">{f.name}</span>
                  {f.soleOwner && <Badge tone="caught">sole owner</Badge>}
                  {f.linkSharing && <Badge tone="awaiting">link-sharing:anyone</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          <PanelHeader title={`linear — ${d.linear.issues.length} issues`} />
          {d.linear.issues.length === 0 ? <Empty>no issues</Empty> : (
            <ul className="divide-y divide-linesoft/60">
              {d.linear.issues.map((i) => (
                <li key={i.id} className="flex items-center gap-2 px-4 py-2">
                  <Mono className="text-accent">{i.identifier}</Mono>
                  <span className="truncate text-dim">{i.title}</span>
                  <Mono className="ml-auto text-faint">{i.state}</Mono>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- plan */

function PlanView({ run }: { run: RunResult }) {
  return (
    <Panel>
      <PanelHeader title={`plan — ${run.decisions.length} actions, in order`} />
      {run.decisions.length === 0 ? <Empty>no plan recorded</Empty> : (
        <ol className="divide-y divide-linesoft/60">
          {run.decisions.map((d, i) => (
            <li key={d.id} className="flex gap-4 px-4 py-3">
              <span className="mono w-6 shrink-0 text-faint">{String(i + 1).padStart(2, "0")}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Mono className="text-fg">{d.operation}</Mono>
                  <Mono className="text-faint">[{d.id}]</Mono>
                </div>
                <div className="mt-1 text-dim">{d.rationale}</div>
                <div className="mono mt-1 text-[11px] text-faint">{JSON.stringify(d.params)}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------ HERO: rehearse */

function Rehearse({ run }: { run: RunResult }) {
  const r = run.rehearsal;
  if (!r) return <Empty>no rehearsal recorded</Empty>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.06] px-4 py-2.5">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="text-dim">
          every action below ran against the <Mono className="text-accent">ShadowAdapter</Mono>. nothing touched production.
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Panel className="overflow-hidden">
          <PanelHeader title="access removed" right={<Badge tone="verified">{r.removed.length}</Badge>} />
          {r.removed.length === 0 ? <Empty>nothing removed</Empty> : (
            <ul className="divide-y divide-linesoft/60">
              {r.removed.map((g, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="mono text-verified">−</span>
                  <Mono className="text-fg line-through decoration-verified/50">{g.resourceName}</Mono>
                  <Mono className="text-dim">{g.permission}</Mono>
                  <Badge tone="neutral">{describeGrantPath(g.path)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel className={r.remaining.length ? "overflow-hidden border-caught/40" : "overflow-hidden"}>
          <PanelHeader
            title="still standing after the plan"
            right={<Badge tone={r.remaining.length ? "caught" : "verified"}>{r.remaining.length}</Badge>}
          />
          {r.remaining.length === 0 ? (
            <Empty><span className="text-verified">nothing remains</span></Empty>
          ) : (
            <>
              <ul className="divide-y divide-linesoft/60">
                {r.remaining.map((g, i) => (
                  <li key={i} className="flex items-center gap-3 bg-caughtbg/40 px-4 py-2.5">
                    <span className="mono text-caught">!</span>
                    <Mono className="text-fg">{g.resourceName}</Mono>
                    <Mono className="text-caught">{g.permission}</Mono>
                    <Badge tone="caught">{describeGrantPath(g.path)}</Badge>
                  </li>
                ))}
              </ul>
              <div className="border-t border-linesoft px-4 py-2 text-[11px] text-faint">
                rehearsal predicted this before a single production write. verify confirms it against live state.
              </div>
            </>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHeader title={`simulated actions — ${r.entries.length}`} />
        <ul className="divide-y divide-linesoft/60">
          {r.entries.map((e) => (
            <li key={e.actionId} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`mono ${e.ok ? "text-verified" : e.error ? "text-caught" : "text-awaiting"}`}>
                  {e.ok ? "✓" : e.error ? "✗" : "!"}
                </span>
                <span className="text-fg">{e.description}</span>
                <Badge tone="neutral">{e.app}</Badge>
                <Badge tone="neutral">{e.kind}</Badge>
                {!e.reversible && <Badge tone="awaiting">irreversible — needs approval</Badge>}
                {e.applied && <Mono className="ml-auto text-faint">→ {e.applied.status}</Mono>}
              </div>
              {e.postconditions.map((p) => (
                <div key={p.checkId} className="mt-1.5 flex items-start gap-2 pl-6">
                  <span className={`mono ${p.result.pass ? "text-verified" : "text-caught"}`}>{p.result.pass ? "✓" : "✗"}</span>
                  <div className="min-w-0">
                    <div className="text-dim">{p.describe}</div>
                    {!p.result.pass && p.result.note && <div className="mono text-[11px] text-caught">{p.result.note}</div>}
                  </div>
                </div>
              ))}
              {e.error && <div className="mono mt-1 pl-6 text-[11px] text-caught">{e.error}</div>}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/* ----------------------------------------------------------------- approve */

function Approve({ run }: { run: RunResult }) {
  const granted = new Set(run.approvals.granted);
  const entries = run.rehearsal?.entries.filter((e) => !e.reversible) ?? [];
  return (
    <Panel>
      <PanelHeader
        title="irreversible actions"
        right={<Badge tone={run.approvals.required.length ? "awaiting" : "verified"}>
          {run.approvals.granted.length}/{run.approvals.required.length} granted
        </Badge>}
      />
      {run.approvals.required.length === 0 ? (
        <Empty>no irreversible actions in this plan</Empty>
      ) : (
        <ul className="divide-y divide-linesoft/60">
          {run.approvals.required.map((id) => {
            const e = entries.find((x) => x.actionId === id);
            const ok = granted.has(id);
            return (
              <li key={id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Badge tone={ok ? "verified" : "awaiting"}>{ok ? "approved" : "withheld"}</Badge>
                <span className="text-fg">{e?.description ?? id}</span>
                <Mono className="text-faint">[{id}]</Mono>
              </li>
            );
          })}
        </ul>
      )}
      <div className="border-t border-linesoft px-4 py-2 text-[11px] text-faint">
        reversibility is a property of the operation, not of the plan — the model cannot mark its own action reversible to skip this gate
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ commit */

const COMMIT_TONE: Record<string, "verified" | "awaiting" | "caught" | "neutral"> = {
  applied: "verified",
  "skipped-idempotent": "neutral",
  "precondition-failed": "awaiting",
  failed: "caught",
  "not-attempted": "neutral",
};

function Commit({ run }: { run: RunResult }) {
  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader title={`commit — live adapter — ${run.commits.length} actions`} />
        <ul className="divide-y divide-linesoft/60">
          {run.commits.map((c) => (
            <li key={c.actionId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <Badge tone={COMMIT_TONE[c.status] ?? "neutral"}>{c.status}</Badge>
              <span className="text-fg">{c.description}</span>
              {c.applied && <Mono className="text-faint">→ {c.applied.status}</Mono>}
              <Mono className="ml-auto max-w-[45%] truncate text-[11px] text-faint">{c.idempotencyKey}</Mono>
              {c.error && <div className="mono w-full text-[11px] text-caught">{c.error}</div>}
            </li>
          ))}
        </ul>
        <div className="border-t border-linesoft px-4 py-2 text-[11px] text-faint">
          idempotency keys are recorded before the call, so a crash between the write and the record cannot replay it
        </div>
      </Panel>

      {run.rollback && (
        <Panel className="border-awaiting/40">
          <PanelHeader title="rollback" right={<Badge tone="awaiting">{run.rollback.succeeded.length} undone</Badge>} />
          <div className="space-y-1 px-4 py-3">
            {run.rollback.succeeded.map((id) => (
              <div key={id} className="flex items-center gap-2"><span className="mono text-verified">↩</span><Mono className="text-dim">{id}</Mono></div>
            ))}
            {run.rollback.failed.map((f) => (
              <div key={f.id} className="flex items-center gap-2"><span className="mono text-caught">✗</span><Mono className="text-caught">{f.id}: {f.error}</Mono></div>
            ))}
            {run.rollback.irreversibleLeftInPlace.map((id) => (
              <div key={id} className="flex items-center gap-2">
                <span className="mono text-awaiting">!</span>
                <Mono className="text-awaiting">{id}</Mono>
                <span className="text-faint">irreversible — left in place, which is why it needed a human first</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- HERO: verify */

function Verify({ run, events }: { run: RunResult; events: TraceEvent[] }) {
  // "Could not determine" is kept apart from "determined it failed". Merging them
  // would inflate the caught count with checks that never actually ran.
  const seenCaught = new Set<string>();
  const caught = run.verification.checks
    .filter((c) => !c.result.pass && !c.result.unverifiable)
    .filter((c) => (seenCaught.has(c.checkId) ? false : (seenCaught.add(c.checkId), true)));
  const unknown = run.verification.checks.filter((c) => c.result.unverifiable);
  const unresolved = new Set(run.verification.failures.map((f) => f.checkId));
  const passed = run.verification.checks.filter((c) => c.result.pass);

  return (
    <div className="space-y-4">
      {caught.length > 0 && (
        <div className="enter space-y-4">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-caught opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-caught" />
            </span>
            <h2 className="text-[15px] font-medium text-caught">
              {caught.length} silent failure{caught.length > 1 ? "s" : ""} caught
            </h2>
            <span className="text-faint">the write reported success; an independent re-read disagreed</span>
          </div>

          {caught.map((f) => {
            const obs = f.result.observed as { permission?: string; survivingPaths?: string[]; surviving?: string[] } | null;
            const commit = run.commits.find((x) => x.actionId === f.actionId);
            const paths = obs?.survivingPaths ?? obs?.surviving ?? [];
            const open = unresolved.has(f.checkId);
            const remediation = events.filter(
              (e) => e.type === "remediation" && e.label.startsWith("remediation:applied"),
            );
            return (
              <Panel key={f.checkId} className="overflow-hidden border-caught/45">
                <PanelHeader
                  title={<span className="text-caught">{f.describe}</span>}
                  right={<Badge tone={open ? "caught" : "verified"}>{open ? "still open" : "closed by remediation"}</Badge>}
                />

                <div className="grid md:grid-cols-2">
                  <div className="border-b border-linesoft p-5 md:border-b-0 md:border-r">
                    <div className="text-[11px] uppercase tracking-[0.08em] text-faint">what the write said</div>
                    <div className="mt-3 flex items-baseline gap-3">
                      <span className="mono text-[34px] leading-none text-verified">{commit?.applied?.status ?? "2xx"}</span>
                      <span className="text-dim">success</span>
                    </div>
                    <div className="mono mt-3 text-[11px] text-faint">{commit?.description ?? f.actionId}</div>
                    <div className="mono mt-1 text-[11px] text-faint">body: {JSON.stringify(commit?.applied?.body ?? null)}</div>
                  </div>

                  <div className="bg-caughtbg/40 p-5">
                    <div className="text-[11px] uppercase tracking-[0.08em] text-faint">what the independent re-read said</div>
                    <div className="mt-3 flex items-baseline gap-3">
                      <span className="mono text-[34px] leading-none text-caught">{obs?.permission ?? "access persists"}</span>
                      <span className="text-dim">still reachable</span>
                    </div>
                    {paths.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-faint">surviving path</span>
                        {paths.map((p) => <Badge key={p} tone="caught">{p}</Badge>)}
                      </div>
                    )}
                    {f.result.note && <div className="mono mt-2 text-[11px] text-caught">{f.result.note}</div>}
                  </div>
                </div>

                {!open && remediation.length > 0 && (
                  <div className="border-t border-linesoft bg-verifiedbg/25 px-5 py-3">
                    <div className="text-[11px] uppercase tracking-[0.08em] text-faint">remediation</div>
                    {remediation.map((e) => (
                      <div key={e.seq} className="mt-1.5 flex items-center gap-2">
                        <span className="mono text-verified">→</span>
                        <span className="text-dim">{e.label.replace("remediation:applied ", "")}</span>
                      </div>
                    ))}
                  </div>
                )}

                <details className="group border-t border-linesoft">
                  <summary className="cursor-pointer px-5 py-2 text-[11px] text-faint hover:text-dim">raw trace lines</summary>
                  <pre className="mono overflow-x-auto bg-bg/60 px-5 py-3 text-[11px] leading-relaxed text-dim">
{events
  .filter((e) => e.actionId === f.actionId || e.checkId === f.checkId)
  .map((e) => `${String(e.seq).padStart(4, "0")}  ${(e.phase ?? "-").padEnd(9)} ${e.type.padEnd(14)} ${e.ok === false ? "FAIL" : e.ok ? "ok  " : "    "}  ${e.label}${e.observed !== undefined ? `\n      observed: ${JSON.stringify(e.observed)}` : ""}`)
  .join("\n")}
                  </pre>
                </details>
              </Panel>
            );
          })}
        </div>
      )}

      {unknown.length > 0 && (
        <Panel className="border-awaiting/40">
          <PanelHeader
            title={<span className="text-awaiting">could not verify — {unknown.length}</span>}
            right={<Badge tone="awaiting">unknown</Badge>}
          />
          <div className="px-5 py-3 text-[11px] text-faint">
            these are not failures. the read itself could not be performed, so nobody knows — and unknown is not success.
          </div>
          <ul className="divide-y divide-linesoft/60">
            {unknown.map((u, i) => (
              <li key={`${u.checkId}-${i}`} className="px-5 py-2.5">
                <div className="text-dim">{u.describe}</div>
                <div className="mono mt-1 text-[11px] text-awaiting">{u.result.note}</div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel>
        <PanelHeader
          title={`postconditions re-read from live — ${run.verification.checks.length}`}
          right={<Badge tone={run.verification.failures.length ? "caught" : unknown.length ? "awaiting" : "verified"}>
            {passed.length} passed · {run.verification.failures.length} open{unknown.length ? ` · ${unknown.length} unknown` : ""}
          </Badge>}
        />
        {run.verification.checks.length === 0 ? (
          <Empty><span className="text-caught">nothing was verified</span></Empty>
        ) : (
          <ul className="divide-y divide-linesoft/60">
            {run.verification.checks.map((c, i) => (
              <li key={`${c.checkId}-${i}`} className="flex items-start gap-3 px-4 py-2">
                <span className={`mono ${c.result.pass ? "text-verified" : c.result.unverifiable ? "text-awaiting" : "text-caught"}`}>
                  {c.result.pass ? "✓" : c.result.unverifiable ? "?" : "✗"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-dim">{c.describe}</div>
                  <div className="mono truncate text-[11px] text-faint">observed: {JSON.stringify(c.result.observed)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-linesoft px-4 py-2 text-[11px] text-faint">
          each check re-reads the API — none of them inspects the response body of the write it follows
        </div>
      </Panel>
    </div>
  );
}
