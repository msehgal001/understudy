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
              ["rollback correctness", `${m.rollbackCorrectness.correct}/${m.rollbackCorrectness.applicable}`, m.rollbackCorrectness.rate === 1 ? "verified" : "caught"],
              ["cost / run", `$${m.costUsdPerRun.toFixed(4)}`, "neutral"],
              ["p50 latency", `${m.latencyP50Ms}ms`, "neutral"],
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
