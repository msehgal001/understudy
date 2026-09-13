import fs from "node:fs";
import path from "node:path";
import { Badge, Panel, PanelHeader, Mono, Empty } from "@/app/ui";
import type { EvalReport } from "@/eval/harness";

export const dynamic = "force-dynamic";

function pct(n: number) { return `${(n * 100).toFixed(1)}%`; }

export default async function EvalPage() {
  const file = path.join(process.cwd(), "eval-report.json");
  if (!fs.existsSync(file)) {
    return <Empty>no report yet — run <Mono className="text-dim">npm run eval</Mono></Empty>;
  }
  const report = JSON.parse(fs.readFileSync(file, "utf8")) as EvalReport;
  const m = report.metrics;
  const zero = m.silentFailureRate === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-lg font-medium tracking-tight">Eval</h1>
        <span className="text-faint">
          <Mono>{m.scenarios}</Mono> scenarios · <Mono>{report.mode}</Mono> · <Mono>{report.plannerModel}</Mono> ·{" "}
          {new Date(report.generatedAt).toLocaleString()}
        </span>
      </div>

      {/* Headline */}
      <Panel className={zero ? "border-verified/40" : "border-caught/50"}>
        <div className="flex flex-wrap items-center gap-x-10 gap-y-5 px-6 py-6">
          <div>
            <div className="text-[11px] uppercase tracking-[0.08em] text-faint">silent failure rate</div>
            <div className={`mono mt-1 text-[46px] leading-none ${zero ? "text-verified" : "text-caught"}`}>
              {pct(m.silentFailureRate)}
            </div>
            <div className="mt-2 max-w-[420px] text-[11px] text-faint">
              runs where the agent claimed success and independent ground truth disagreed. the oracle never calls a check the
              agent uses, so this measures the agent rather than its own opinion of itself.
            </div>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
            {[
              ["task success", pct(m.taskSuccessRate), m.taskSuccessRate === 1 ? "verified" : "awaiting"],
              ["caught", String(m.silentFailuresCaught), "verified"],
              ["missed", String(m.silentFailuresMissed), m.silentFailuresMissed === 0 ? "verified" : "caught"],
              ["blocked by design", String(m.blockedByDesign), "neutral"],
              ["rollback correctness", `${m.rollbackCorrectness.correct}/${m.rollbackCorrectness.applicable}`, m.rollbackCorrectness.rate === 1 ? "verified" : "caught"],
              // Cost comes from the MODEL arm. The naive baseline makes no model
              // calls, so quoting the primary arm here would read as $0.0000.
              ["cost / run", `$${(report.arms?.find((a) => a.planner.startsWith("claude"))?.metrics.costUsdPerRun ?? m.costUsdPerRun).toFixed(4)}`, "neutral"],
              // Latency is deliberately absent. Every number on this page comes from
              // the replay harness, where a scenario finishes in ~1ms; printing that
              // as agent latency would be the exact kind of flattering, meaningless
              // measurement this project exists to argue against. Live wall-clock is
              // in the README.
              ["mutants killed", report.mutation ? `${report.mutation.filter((x) => x.killed).length}/${report.mutation.length}` : "—",
                report.mutation && report.mutation.every((x) => x.killed) ? "verified" : "caught"],
            ].map(([label, value, tone]) => (
              <div key={label}>
                <div className="text-[11px] uppercase tracking-[0.08em] text-faint">{label}</div>
                <div className={`mono mt-1 text-[22px] leading-none ${
                  tone === "verified" ? "text-verified" : tone === "caught" ? "text-caught" : tone === "awaiting" ? "text-awaiting" : "text-fg"
                }`}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </Panel>

      {report.mutation && report.mutation.length > 0 && (
        <Panel className={report.mutation.every((x) => x.killed) ? "border-verified/40" : "border-caught/50"}>
          <PanelHeader title="mutation testing" />
          <div className="px-4 pb-4 pt-3">
            <p className="mb-3 max-w-[760px] text-[12px] text-faint">
              an eval that cannot fail measures nothing. each mutant disables one safety check on purpose and the suite
              must go red. a surviving mutant would mean the corpus never exercises that check, so a green run proves
              nothing about it.
            </p>
            <ul className="space-y-1.5">
              {report.mutation.map((x) => (
                <li key={x.mutant} className="flex flex-wrap items-center gap-2">
                  <Badge tone={x.killed ? "verified" : "caught"}>{x.killed ? "killed" : "survived"}</Badge>
                  <Mono className="text-fg">{x.mutant}</Mono>
                  <span className="text-[12px] text-faint">{x.describe}</span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      )}

      {report.arms && report.arms.length > 1 && (
        <Panel>
          <PanelHeader title="naive baseline vs model planner" />
          <div className="px-4 pb-4 pt-3">
            <p className="mb-3 max-w-[760px] text-[12px] text-faint">
              the naive arm plans the obvious way and leaves inherited grants standing, so verify has real work to do.
              the model arm resolves grant paths while planning and usually leaves nothing. both end at zero missed.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {report.arms.map((a) => (
                <div key={a.planner} className="rounded border border-linesoft/60 px-3 py-2.5">
                  <Mono className="text-fg">{a.planner}</Mono>
                  <div className="mt-1 text-[11px] text-faint">{a.describe}</div>
                  <div className="mono mt-2 text-[12px] text-dim">
                    caught <span className="text-verified">{a.metrics.silentFailuresCaught}</span>
                    {"  ·  missed "}
                    <span className={a.metrics.silentFailuresMissed === 0 ? "text-verified" : "text-caught"}>
                      {a.metrics.silentFailuresMissed}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader title="scenario corpus" />
        <ul className="divide-y divide-linesoft/60">
          {report.scenarios.map((s) => (
            <li key={s.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={s.taskSuccess ? "verified" : "caught"}>{s.taskSuccess ? "pass" : "fail"}</Badge>
                <Mono className="text-fg">{s.id}</Mono>
                <span className="text-dim">{s.title}</span>
                <div className="ml-auto flex items-center gap-2">
                  {s.caughtInVerify > 0 && <Badge tone="awaiting">caught {s.caughtInVerify}</Badge>}
                  {s.silentFailure && <Badge tone="caught">silent failure</Badge>}
                  <Badge tone="neutral">{s.status}</Badge>
                  <Mono className="text-[11px] text-faint">{s.durationMs}ms</Mono>
                </div>
              </div>
              <div className="mt-1.5 max-w-[900px] text-[12px] text-faint">{s.proves}</div>
              {!s.taskSuccess && (
                <div className="mt-2 space-y-1">
                  {s.oracle.filter((o) => !o.pass).map((o, i) => (
                    <div key={i} className="mono text-[11px] text-caught">
                      oracle disagrees: {o.assertion} → {JSON.stringify(o.observed)}
                    </div>
                  ))}
                  <div className="text-[11px] text-dim">{s.summary}</div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
