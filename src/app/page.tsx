import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { listRuns } from "@/core/db";
import { Badge, Panel, PanelHeader, Mono, Empty, statusTone } from "@/app/ui";
import { Launcher } from "@/app/launcher";

export const dynamic = "force-dynamic";

export default async function Home() {
  let runs: ReturnType<typeof listRuns> = [];
  let error: string | null = null;
  try {
    runs = listRuns();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const scenarioDir = path.join(process.cwd(), "src/eval/scenarios");
  const scenarios = fs.existsSync(scenarioDir)
    ? fs.readdirSync(scenarioDir).filter((f) => f.endsWith(".json")).sort().map((f) => f.replace(/\.json$/, ""))
    : [];

  return (
    <div className="space-y-5">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-medium tracking-tight">Runs</h1>
        <span className="text-faint">offboarding executions, newest first</span>
      </div>

      <Launcher scenarios={scenarios} />

      <Panel>
        <PanelHeader title="execution history" right={<span className="mono text-[11px] text-faint">{runs.length}</span>} />
        {error ? (
          <Empty>
            no database yet — run <Mono className="text-dim">npm run offboard -- --scenario=01-inherited-team-access --yes</Mono>
          </Empty>
        ) : runs.length === 0 ? (
          <Empty>
            nothing here yet. run{" "}
            <Mono className="text-dim">npm run offboard -- --scenario=01-inherited-team-access --yes</Mono>
          </Empty>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-linesoft text-[11px] uppercase tracking-[0.08em] text-faint">
                <th className="px-4 py-2 font-medium">run</th>
                <th className="px-4 py-2 font-medium">status</th>
                <th className="px-4 py-2 font-medium">target</th>
                <th className="px-4 py-2 font-medium">mode</th>
                <th className="px-4 py-2 font-medium">summary</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-linesoft/60 last:border-0 hover:bg-panel2/60">
                  <td className="px-4 py-2.5">
                    <Link href={`/run/${r.id}/verify`} className="mono text-accent hover:underline">{r.id}</Link>
                  </td>
                  <td className="px-4 py-2.5"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                  <td className="px-4 py-2.5"><Mono className="text-dim">{r.target}</Mono></td>
                  <td className="px-4 py-2.5"><Mono className="text-faint">{r.mode}</Mono></td>
                  <td className="max-w-[520px] truncate px-4 py-2.5 text-dim">{r.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
