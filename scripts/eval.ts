import fs from "node:fs";
import path from "node:path";
import { runEval, loadScenarios } from "@/eval/harness";
import { stubPlanner } from "@/agent/stub-planner";
import { makePlanner, PLANNER_MODEL } from "@/agent/loop";
import { loadEnv } from "@/core/config";
import { green, red, amber, dim, bold, mono } from "@/cli/render";
import type { Tracer } from "@/core/trace";
import type { Scenario } from "@/eval/types";
import type { PlanDecision } from "@/actions/index";

loadEnv();

const args = process.argv.slice(2);
const live = args.includes("--live");
const record = live || args.includes("--record");
const only = args.find((a) => a.startsWith("--only="))?.split("=")[1];
const CACHE = path.join(process.cwd(), "src/eval/recorded-plans.json");

type Recorded = Record<string, { decisions: PlanDecision[]; summary: string; tokens: { input: number; output: number } }>;

const loadScenarioIds = () => loadScenarios().map((s) => s.id);

async function main() {
  const cache: Recorded = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  let wrote = false;

  // Default is replay: a recorded plan if one exists, otherwise the deterministic
  // stub. The suite stays free and instant unless --live or --record is asked for.
  const planner = (t: Tracer, s: Scenario) => {
    if (record) {
      return makePlanner(t, {
        recorder: {
          key: s.id,
          lookup: (k) => (live ? null : (cache[k] ?? null)),
          // First write wins. Scenario 10 deliberately executes twice to prove
          // replay protection, and the second pass plans against an already
          // offboarded world — so without this the recording gets overwritten
          // with an empty plan and the fixture silently stops testing anything.
          record: (k, v) => { if (!cache[k]) { cache[k] = v; wrote = true; } },
        },
      });
    }
    if (cache[`${s.id}:first`]) {
      // Replay only. Never reaches the network.
      return makePlanner(t, { recorder: { key: s.id, lookup: (k) => cache[k] ?? null } });
    }
    return stubPlanner;
  };

  const recorded = loadScenarioIds().filter((id) => cache[`${id}:first`]).length;
  const usingModel = record
    ? PLANNER_MODEL
    : recorded
      ? `${PLANNER_MODEL} (replayed, ${recorded} recorded)`
      : "deterministic-stub";
  const report = await runEval(planner, {
    mode: live ? "live" : "replay",
    plannerModel: usingModel,
    traceDir: path.join(process.cwd(), "traces/eval"),
    only,
  });

  if (wrote) fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2) + "\n");
  fs.writeFileSync(path.join(process.cwd(), "eval-report.json"), JSON.stringify(report, null, 2) + "\n");

  const m = report.metrics;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`\n${bold("UNDERSTUDY EVAL")}  ${dim(`${report.mode} · ${report.plannerModel} · ${m.scenarios} scenarios`)}\n`);

  for (const s of report.scenarios) {
    const mark = s.taskSuccess ? green("PASS") : red("FAIL");
    const silent = s.silentFailure ? red(" SILENT-FAILURE") : "";
    const caught = s.caughtInVerify ? amber(` caught:${s.caughtInVerify}`) : "";
    console.log(`  ${mark}  ${mono(s.id.padEnd(30))} ${s.status.padEnd(12)}${caught}${silent}`);
    if (!s.taskSuccess) {
      for (const o of s.oracle.filter((x) => !x.pass)) {
        console.log(`        ${red("oracle disagrees:")} ${o.assertion} ${dim(JSON.stringify(o.observed))}`);
      }
      console.log(`        ${dim(s.summary)}`);
    }
  }

  const sfColour = m.silentFailureRate === 0 ? green : red;
  console.log(`\n${bold("METRICS")}`);
  console.log(`  task success rate        ${pct(m.taskSuccessRate)}`);
  console.log(`  ${bold("silent failure rate")}      ${sfColour(bold(pct(m.silentFailureRate)))}   ${dim("(claimed success, ground truth disagreed)")}`);
  console.log(`  silent failures caught   ${m.silentFailuresCaught}`);
  console.log(`  silent failures missed   ${m.silentFailuresMissed === 0 ? green("0") : red(String(m.silentFailuresMissed))}`);
  console.log(`  rollback correctness     ${m.rollbackCorrectness.correct}/${m.rollbackCorrectness.applicable} (${pct(m.rollbackCorrectness.rate)})`);
  console.log(`  cost per run             $${m.costUsdPerRun.toFixed(4)}   ${dim(`total $${m.costUsdTotal.toFixed(4)}`)}`);
  console.log(`  latency p50 / p95        ${m.latencyP50Ms}ms / ${m.latencyP95Ms}ms`);
  console.log(`\n  ${dim("report written to eval-report.json")}\n`);

  const failed = report.scenarios.filter((s) => !s.taskSuccess).length;
  process.exit(failed > 0 || m.silentFailureRate > 0 ? 1 : 0);
}
main();
