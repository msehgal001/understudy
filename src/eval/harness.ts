import fs from "node:fs";
import path from "node:path";
import { runScenario, type ScenarioRun } from "@/eval/run-scenario";
import type { Scenario } from "@/eval/types";
import type { Planner } from "@/core/executor";
import type { Tracer } from "@/core/trace";

export type EvalMetrics = {
  scenarios: number;
  taskSuccessRate: number;
  /** THE HEADLINE. Agent claimed success; independent ground truth disagreed. */
  silentFailureRate: number;
  silentFailuresCaught: number;
  silentFailuresMissed: number;
  rollbackCorrectness: { applicable: number; correct: number; rate: number };
  costUsdTotal: number;
  costUsdPerRun: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
};

export type EvalReport = {
  generatedAt: string;
  mode: "replay" | "live";
  plannerModel: string;
  metrics: EvalMetrics;
  scenarios: {
    id: string;
    title: string;
    proves: string;
    status: string;
    taskSuccess: boolean;
    claimedSuccess: boolean;
    groundTruthOk: boolean;
    silentFailure: boolean;
    caughtInVerify: number;
    remediationRounds: number;
    rollbackCorrect: boolean | null;
    durationMs: number;
    costUsd: number;
    oracle: { assertion: string; pass: boolean; observed: unknown }[];
    summary: string;
    tracePath: string | null;
  }[];
};

export function loadScenarios(dir = path.join(process.cwd(), "src/eval/scenarios")): Scenario[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Scenario);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export async function runEval(
  makePlanner: (t: Tracer, scenario: Scenario) => Planner,
  opts: { mode: "replay" | "live"; plannerModel: string; traceDir?: string; only?: string },
): Promise<EvalReport> {
  const scenarios = loadScenarios().filter((s) => (opts.only ? s.id.includes(opts.only) : true));
  const runs: ScenarioRun[] = [];

  for (const s of scenarios) {
    const run = await runScenario(s, (t) => makePlanner(t, s), { traceDir: opts.traceDir });
    runs.push(run);
  }

  const rollbackRuns = runs.filter((r) => r.rollbackCorrect !== null);
  const latencies = runs.map((r) => r.durationMs);

  const metrics: EvalMetrics = {
    scenarios: runs.length,
    taskSuccessRate: runs.length ? runs.filter((r) => r.taskSuccess).length / runs.length : 0,
    silentFailureRate: runs.length ? runs.filter((r) => r.silentFailure).length / runs.length : 0,
    silentFailuresCaught: runs.reduce((n, r) => n + r.caughtInVerify, 0),
    silentFailuresMissed: runs.filter((r) => r.silentFailure).length,
    rollbackCorrectness: {
      applicable: rollbackRuns.length,
      correct: rollbackRuns.filter((r) => r.rollbackCorrect).length,
      rate: rollbackRuns.length ? rollbackRuns.filter((r) => r.rollbackCorrect).length / rollbackRuns.length : 1,
    },
    costUsdTotal: runs.reduce((n, r) => n + r.costUsd, 0),
    costUsdPerRun: runs.length ? runs.reduce((n, r) => n + r.costUsd, 0) / runs.length : 0,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
  };

  return {
    generatedAt: new Date().toISOString(),
    mode: opts.mode,
    plannerModel: opts.plannerModel,
    metrics,
    scenarios: runs.map((r) => ({
      id: r.scenario.id,
      title: r.scenario.title,
      proves: r.scenario.proves,
      status: r.result.status,
      taskSuccess: r.taskSuccess,
      claimedSuccess: r.claimedSuccess,
      groundTruthOk: r.groundTruthOk,
      silentFailure: r.silentFailure,
      caughtInVerify: r.caughtInVerify,
      remediationRounds: r.result.remediationRounds,
      rollbackCorrect: r.rollbackCorrect,
      durationMs: r.durationMs,
      costUsd: r.costUsd,
      oracle: r.oracle.map((o) => ({ assertion: JSON.stringify(o.assertion), pass: o.pass, observed: o.observed })),
      summary: r.result.summary,
      tracePath: r.tracePath,
    })),
  };
}
