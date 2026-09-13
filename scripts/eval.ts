import fs from "node:fs";
import path from "node:path";
import { runEval, loadScenarios, type EvalReport, type EvalMetrics } from "@/eval/harness";
import { stubPlanner } from "@/agent/stub-planner";
import { makePlanner, PLANNER_MODEL } from "@/agent/loop";
import { setMutation } from "@/eval/mutate";
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
const mutate = args.find((a) => a.startsWith("--mutate="))?.split("=")[1] ?? null;
const quiet = args.includes("--quiet");
const which = (args.find((a) => a.startsWith("--planner="))?.split("=")[1] ?? "both") as "naive" | "model" | "both";
const CACHE = path.join(process.cwd(), "src/eval/recorded-plans.json");

type Recorded = Record<string, { decisions: PlanDecision[]; summary: string; tokens: { input: number; output: number } }>;

/**
 * Two arms, and the default runs both.
 *
 * The NAIVE arm plans the obvious way: drop the direct collaborator, delete the
 * user's permission, trust the write. Inherited paths survive, so this is the arm
 * where verify has real work to do — it is the baseline that proves the safety
 * net catches things.
 *
 * The MODEL arm replays recorded Sonnet plans. Sonnet reads the enumerated grant
 * paths and closes them up front, so verify usually finds nothing. That is the
 * good outcome, but on its own it is an eval that cannot fail: a broken check
 * looks identical to a correct one. Reporting only this arm was the bug.
 */
async function main() {
  if (mutate) setMutation(mutate);

  const cache: Recorded = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  let wrote = false;

  const modelPlanner = (t: Tracer, s: Scenario) => {
    if (record) {
      return makePlanner(t, {
        recorder: {
          key: s.id,
          lookup: (k) => (live ? null : (cache[k] ?? null)),
          // First write wins. Scenario 10 deliberately executes twice to prove
          // replay protection, and the second pass plans against an already
          // offboarded world.
          record: (k, v) => { if (!cache[k]) { cache[k] = v; wrote = true; } },
        },
      });
    }
    if (cache[`${s.id}:first`]) return makePlanner(t, { recorder: { key: s.id, lookup: (k) => cache[k] ?? null } });
    return stubPlanner;
  };

  const recorded = loadScenarios().map((s) => s.id).filter((id) => cache[`${id}:first`]).length;
  const modelLabel = record ? PLANNER_MODEL : `${PLANNER_MODEL} (replayed, ${recorded} recorded)`;

  const arms: { key: "naive" | "model"; planner: string; describe: string; report: EvalReport }[] = [];

  if (which === "naive" || which === "both") {
    arms.push({
      key: "naive",
      planner: "naive-baseline",
      describe: "plans the obvious way; inherited grants survive and verify must catch them",
      report: await runEval(() => stubPlanner, {
        mode: "replay", plannerModel: "naive-baseline",
        traceDir: path.join(process.cwd(), "traces/eval/naive"), only,
      }),
    });
  }
  if (which === "model" || which === "both") {
    arms.push({
      key: "model",
      planner: modelLabel,
      describe: "resolves grant paths during planning, so verify usually finds nothing left",
      report: await runEval(modelPlanner, {
        mode: live ? "live" : "replay", plannerModel: modelLabel,
        traceDir: path.join(process.cwd(), "traces/eval/model"), only,
      }),
    });
  }

  if (wrote) fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2) + "\n");

  // The naive arm is primary: it is the one that exercises the verify layer.
  const primary = arms.find((a) => a.key === "naive") ?? arms[0];
  const report: EvalReport = {
    ...primary.report,
    arms: arms.map((a) => ({ planner: a.planner, describe: a.describe, metrics: a.report.metrics })),
  };
  if (!mutate) {
    // `npm run eval` and `npm run eval:mutation` write the same report, and
    // rewriting it wholesale blanked the mutants tile on the console whenever the
    // eval ran last. That made a headline claim order-dependent, on the command
    // most likely to be run in front of people. Carry a prior result forward.
    const reportPath = path.join(process.cwd(), "eval-report.json");
    const prior = fs.existsSync(reportPath)
      ? ((JSON.parse(fs.readFileSync(reportPath, "utf8")) as { mutation?: EvalReport["mutation"] }).mutation ?? null)
      : null;
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ ...report, mutation: report.mutation ?? prior ?? undefined }, null, 2) + "\n",
    );
  }

  const anyFailed = arms.some((a) => a.report.scenarios.some((s) => !s.taskSuccess) || a.report.metrics.silentFailureRate > 0);
  if (quiet) { process.exit(anyFailed ? 1 : 0); }

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  for (const a of arms) {
    const m = a.report.metrics;
    console.log(`\n${bold("UNDERSTUDY EVAL")}  ${dim(`${a.planner} · ${a.report.mode} · ${m.scenarios} scenarios`)}`);
    console.log(`${dim(`  ${a.describe}`)}\n`);
    for (const s of a.report.scenarios) {
      const mark = s.taskSuccess ? green("PASS") : red("FAIL");
      const silent = s.silentFailure ? red(" SILENT-FAILURE") : "";
      const caught = s.caughtInVerify ? amber(` caught:${s.caughtInVerify}`) : "";
      const blocked = s.blockedByDesign ? dim(` blocked:${s.blockedByDesign}`) : "";
      console.log(`  ${mark}  ${mono(s.id.padEnd(30))} ${s.status.padEnd(12)}${caught}${blocked}${silent}`);
      if (!s.taskSuccess) {
        for (const o of s.oracle.filter((x) => !x.pass)) {
          console.log(`        ${red("oracle disagrees:")} ${o.assertion} ${dim(JSON.stringify(o.observed))}`);
        }
      }
    }
    const sf = m.silentFailureRate === 0 ? green : red;
    console.log(`\n  task success rate        ${pct(m.taskSuccessRate)}`);
    console.log(`  ${bold("silent failure rate")}      ${sf(bold(pct(m.silentFailureRate)))}   ${dim("(claimed success, ground truth disagreed)")}`);
    console.log(`  silent failures caught   ${m.silentFailuresCaught}   ${dim("(write reported success, re-read disagreed)")}`);
    console.log(`  silent failures missed   ${m.silentFailuresMissed === 0 ? green("0") : red(String(m.silentFailuresMissed))}`);
    console.log(`  blocked by design        ${m.blockedByDesign}   ${dim("(action never ran; the approval gate holding)")}`);
    console.log(`  rollback correctness     ${m.rollbackCorrectness.correct}/${m.rollbackCorrectness.applicable} (${pct(m.rollbackCorrectness.rate)})`);
    console.log(`  cost per run             $${m.costUsdPerRun.toFixed(4)}   ${dim(`total $${m.costUsdTotal.toFixed(4)}`)}`);
  }

  if (arms.length === 2) {
    const [n, mo] = arms.map((a) => a.report.metrics) as [EvalMetrics, EvalMetrics];
    console.log(`\n${bold("NAIVE vs MODEL")}`);
    console.log(`  ${"".padEnd(26)}${"naive".padEnd(12)}model`);
    console.log(`  ${"silent failures caught".padEnd(26)}${String(n.silentFailuresCaught).padEnd(12)}${mo.silentFailuresCaught}`);
    console.log(`  ${"silent failures missed".padEnd(26)}${String(n.silentFailuresMissed).padEnd(12)}${mo.silentFailuresMissed}`);
    console.log(`  ${dim("the net catches what the planner misses; both end at zero missed")}`);
  }
  console.log(`\n  ${dim("report written to eval-report.json")}\n`);
  process.exit(anyFailed ? 1 : 0);
}
main();
