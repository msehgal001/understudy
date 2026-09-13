import fs from "node:fs";
import readline from "node:readline/promises";
import { adapterSet } from "@/adapters/registry";
import { execute } from "@/core/executor";
import { Tracer } from "@/core/trace";
import { readConfig } from "@/core/config";
import { seedWorldFromLive } from "@/core/seed";
import { cloneWorld } from "@/core/world";
import { makePlanner, PLANNER_MODEL } from "@/agent/loop";
import { stubPlanner } from "@/agent/stub-planner";
import { judgeTrace } from "@/agent/judge";
import { renderRehearsal, renderVerification, renderSummary, bold, dim, amber, green, red, mono } from "@/cli/render";
import { saveRun, saveEvents, recordKeys, loadCompletedKeys } from "@/core/db";
import type { Action } from "@/core/action";
import type { Scenario } from "@/eval/types";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

async function main() {
  const config = readConfig();
  const mode = (opt("mode") ?? "shadow") as "live" | "shadow";
  const scenarioId = opt("scenario");
  const autoApprove = flag("yes");
  const runId = opt("run") ?? `run-${Date.now().toString(36)}`;

  const tracer = new Tracer(runId);

  let live, shadow, build;

  if (scenarioId) {
    // Fixture-backed run: both sides are shadow over separate worlds.
    const s = JSON.parse(fs.readFileSync(`src/eval/scenarios/${scenarioId}.json`, "utf8")) as Scenario;
    const liveWorld = cloneWorld(s.world);
    live = adapterSet("shadow", { world: liveWorld, faults: s.faults ?? [] });
    shadow = adapterSet("shadow", { world: cloneWorld(s.world) });
    build = { org: s.world.github.org, target: s.target, slackChannel: s.slackChannel };
    console.log(`${dim("scenario")} ${mono(s.id)} — ${s.title}`);
  } else if (mode === "live") {
    if (!config.githubToken || !config.githubOrg || !config.target.githubLogin) {
      console.error(red("live mode needs GITHUB_TOKEN, GITHUB_ORG and DEPARTING_GITHUB_LOGIN. Run `npm run preflight`."));
      process.exit(2);
    }
    live = adapterSet("live", { config });
    const world = await seedWorldFromLive(live, config.target, config.githubOrg, tracer);
    shadow = adapterSet("shadow", { world });
    build = { org: config.githubOrg, target: config.target, slackChannel: config.slackChannel };
  } else {
    console.error(red("shadow mode without --scenario has nothing to read from. Pass --scenario=<id> or --mode=live."));
    process.exit(2);
  }

  const planner = process.env.ANTHROPIC_API_KEY ? makePlanner(tracer) : stubPlanner;
  if (!process.env.ANTHROPIC_API_KEY) console.log(amber("no ANTHROPIC_API_KEY — using the deterministic stub planner"));
  else console.log(dim(`planner: ${PLANNER_MODEL}`));

  const approver = async (pending: Action[]) => {
    const ids = new Set<string>();
    console.log(`\n${amber(bold("APPROVAL REQUIRED"))} ${dim("— these actions cannot be undone")}`);
    for (const a of pending) console.log(`  ${amber("!")} ${a.description}  ${dim(`[${a.id}]`)}`);
    if (flag("deny")) {
      console.log(dim("  --deny: all irreversible actions withheld"));
    } else if (autoApprove) {
      for (const a of pending) ids.add(a.id);
      console.log(dim("  --yes: approved"));
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      for (const a of pending) {
        const ans = (await rl.question(`  approve "${a.description}"? [y/N] `)).trim().toLowerCase();
        if (ans === "y" || ans === "yes") ids.add(a.id);
      }
      rl.close();
    }
    // The trace judge caught the absence of this: approvals were being granted
    // with no record of who decided what. An approval gate that leaves no
    // evidence is not an audit trail.
    tracer.emit({
      type: "phase", phase: "approve", label: "approve:decision",
      detail: {
        decidedBy: flag("deny") ? "--deny flag" : autoApprove ? "--yes flag" : "operator at the terminal",
        granted: [...ids],
        withheld: pending.filter((a) => !ids.has(a.id)).map((a) => a.id),
      },
    });
    return ids;
  };

  const completedKeys = scenarioId ? new Set<string>() : loadCompletedKeys(build.target.githubLogin);

  const result = await execute({
    runId, tracer, build, live, shadow, planner, approver, completedKeys,
    skipVerify: flag("skip-verify"),
  });

  if (result.rehearsal) console.log(renderRehearsal(result.rehearsal));
  console.log(renderVerification(result));
  console.log(renderSummary(result));

  tracer.close();
  saveRun(result, { mode: scenarioId ? `scenario:${scenarioId}` : mode, target: build.target.githubLogin, org: build.org });
  saveEvents(runId, tracer.events);
  if (!scenarioId) recordKeys(runId, build.target.githubLogin, completedKeys);
  console.log(`\n  ${dim(`trace: traces/${runId}.jsonl   run id: ${runId}`)}`);

  if (flag("judge")) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log(amber("\n  --judge needs ANTHROPIC_API_KEY"));
    } else {
      console.log(dim("\n  judging trace with claude-opus-5..."));
      const v = await judgeTrace(tracer.events);
      const colour = v.verdict === "achieved" ? green : v.verdict === "partial" ? amber : red;
      console.log(`\n${bold("TRACE JUDGE")}`);
      console.log(`  verdict     ${colour(bold(v.verdict))} ${dim(`(${v.confidence} confidence)`)}`);
      console.log(`  ${v.reasoning}`);
      for (const d of v.discrepancies) {
        console.log(`  ${d.severity === "high" ? red("●") : d.severity === "medium" ? amber("●") : dim("●")} ${d.description}`);
        console.log(`    ${dim(d.evidence)}`);
      }
      console.log(`  ${dim(`$${v.costUsd.toFixed(4)} · ${v.tokens.input} in / ${v.tokens.output} out`)}`);
    }
  }

  process.exit(result.status === "verified" ? 0 : 1);
}
main();
