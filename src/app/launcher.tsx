"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TraceEvent } from "@/core/trace";

const PHASE_ORDER = ["discover", "plan", "rehearse", "approve", "commit", "verify"] as const;

export function Launcher({ scenarios }: { scenarios: string[] }) {
  const router = useRouter();
  const [scenario, setScenario] = useState(scenarios[0] ?? "");
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [running, setRunning] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(`/api/runs/${runId}/stream`);
    es.addEventListener("trace", (e) => {
      setEvents((prev) => [...prev, JSON.parse((e as MessageEvent).data) as TraceEvent]);
    });
    es.addEventListener("done", () => {
      es.close();
      setRunning(false);
      router.refresh();
    });
    es.onerror = () => { es.close(); setRunning(false); };
    return () => es.close();
  }, [runId, router]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events]);

  async function start(mode: "scenario" | "live") {
    setEvents([]);
    setRunning(true);
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mode === "scenario" ? { scenario, approve: true } : { mode: "live", approve: false }),
    });
    const { runId: id } = (await res.json()) as { runId: string };
    setRunId(id);
  }

  const phase = [...events].reverse().find((e) => e.phase)?.phase ?? null;
  const caught = events.filter((e) => e.type === "postcondition" && e.phase === "verify" && e.ok === false).length;

  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-linesoft px-4 py-3">
        <span className="text-[11px] uppercase tracking-[0.08em] text-faint">start a run</span>
        <select
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          disabled={running}
          className="mono rounded border border-line bg-panel2 px-2 py-1 text-[12px] text-fg outline-none focus:border-accent disabled:opacity-50"
        >
          {scenarios.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button
          onClick={() => start("scenario")}
          disabled={running || !scenario}
          className="mono rounded border border-accent/40 bg-accent/10 px-3 py-1 text-[12px] text-accent hover:bg-accent/20 disabled:opacity-40"
        >
          {running ? "running…" : "run fixture"}
        </button>
        <button
          onClick={() => start("live")}
          disabled={running}
          className="mono rounded border border-caught/40 bg-caughtbg px-3 py-1 text-[12px] text-caught hover:bg-caught/20 disabled:opacity-40"
          title="Runs against the real GitHub / Drive / Linear / Slack APIs"
        >
          run live
        </button>

        {runId && (
          <div className="ml-auto flex items-center gap-3">
            {PHASE_ORDER.map((p) => (
              <span key={p} className={`mono text-[11px] ${p === phase ? "text-accent" : events.some((e) => e.phase === p) ? "text-dim" : "text-faint/50"}`}>
                {p}
              </span>
            ))}
            {caught > 0 && <span className="mono text-[11px] text-caught">caught {caught}</span>}
          </div>
        )}
      </div>

      {runId && (
        <>
          <div ref={feedRef} className="max-h-64 overflow-y-auto px-4 py-2">
            {events.map((e) => (
              <div key={e.seq} className="mono flex gap-3 py-[1px] text-[11px]">
                <span className="w-9 shrink-0 text-faint">{String(e.seq).padStart(4, "0")}</span>
                <span className="w-16 shrink-0 text-faint">{e.phase ?? "—"}</span>
                <span className={`w-11 shrink-0 ${e.ok === false ? "text-caught" : e.ok ? "text-verified" : "text-faint"}`}>
                  {e.ok === false ? "FAIL" : e.ok ? "ok" : ""}
                </span>
                <span className={e.ok === false ? "text-caught" : "text-dim"}>{e.label}</span>
              </div>
            ))}
            {!events.length && <div className="py-3 text-[12px] text-faint">waiting for the first event…</div>}
          </div>
          <div className="border-t border-linesoft px-4 py-2">
            <a href={`/run/${runId}/verify`} className="mono text-[12px] text-accent hover:underline">
              open {runId} →
            </a>
          </div>
        </>
      )}
    </div>
  );
}
