import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvents, getRun } from "@/core/db";
import { Badge, Panel, PanelHeader, Empty, statusTone } from "@/app/ui";
import type { TraceEvent } from "@/core/trace";

export const dynamic = "force-dynamic";

const TYPE_TONE: Record<string, string> = {
  phase: "text-accent",
  model: "text-awaiting",
  tool: "text-faint",
  precondition: "text-dim",
  postcondition: "text-dim",
  action: "text-fg",
  rollback: "text-awaiting",
  remediation: "text-awaiting",
  note: "text-faint",
};

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let events: TraceEvent[] = [];
  let run = null;
  try {
    events = getEvents(id);
    run = getRun(id);
  } catch {
    /* no db */
  }
  if (!events.length) notFound();

  const totals = events.reduce(
    (acc, e) => {
      if (e.tokens) { acc.input += e.tokens.input; acc.output += e.tokens.output; }
      if (e.costUsd) acc.cost += e.costUsd;
      if (e.durationMs) acc.ms += e.durationMs;
      return acc;
    },
    { input: 0, output: 0, cost: 0, ms: 0 },
  );
  const failures = events.filter((e) => e.ok === false).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="mono text-[15px] font-medium">trace / {id}</h1>
        {run && <Badge tone={statusTone(run.status)}>{run.status}</Badge>}
        <Link href={`/run/${id}/verify`} className="mono ml-auto text-[12px] text-accent hover:underline">← run</Link>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["events", String(events.length)],
          ["failed steps", String(failures)],
          ["tokens in/out", `${totals.input}/${totals.output}`],
          ["cost", `$${totals.cost.toFixed(4)}`],
          ["recorded time", `${totals.ms}ms`],
        ].map(([label, value]) => (
          <Panel key={label} className="px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.08em] text-faint">{label}</div>
            <div className="mono mt-1 text-[18px]">{value}</div>
          </Panel>
        ))}
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader title="structured trace — the artifact the eval scores and the judge reads" />
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-linesoft text-[11px] uppercase tracking-[0.08em] text-faint">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">phase</th>
                <th className="px-3 py-2 font-medium">type</th>
                <th className="px-3 py-2 font-medium">ok</th>
                <th className="px-3 py-2 font-medium">label</th>
                <th className="px-3 py-2 font-medium">observed</th>
                <th className="px-3 py-2 font-medium text-right">ms</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.seq} className={`border-b border-linesoft/40 last:border-0 ${e.ok === false ? "bg-caughtbg/35" : ""}`}>
                  <td className="mono px-3 py-1.5 text-faint">{String(e.seq).padStart(4, "0")}</td>
                  <td className="mono px-3 py-1.5 text-faint">{e.phase ?? "—"}</td>
                  <td className={`mono px-3 py-1.5 ${TYPE_TONE[e.type] ?? "text-dim"}`}>{e.type}</td>
                  <td className="mono px-3 py-1.5">
                    {e.ok === undefined ? <span className="text-faint">—</span>
                      : e.ok ? <span className="text-verified">ok</span>
                      : <span className="text-caught">FAIL</span>}
                  </td>
                  <td className="px-3 py-1.5 text-dim">{e.label}</td>
                  <td className="mono max-w-[420px] truncate px-3 py-1.5 text-[11px] text-faint">
                    {e.observed !== undefined ? JSON.stringify(e.observed) : e.detail !== undefined ? JSON.stringify(e.detail) : ""}
                  </td>
                  <td className="mono px-3 py-1.5 text-right text-faint">{e.durationMs ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {events.length === 0 && <Empty>no events</Empty>}
    </div>
  );
}
