import fs from "node:fs";
import { runScenario } from "@/eval/run-scenario";
import { stubPlanner } from "@/agent/stub-planner";
import { renderRehearsal, renderVerification, renderSummary } from "@/cli/render";
import type { Scenario } from "@/eval/types";

async function main() {
const id = process.argv[2] ?? "01-inherited-team-access";
const s = JSON.parse(fs.readFileSync(`src/eval/scenarios/${id}.json`, "utf8")) as Scenario;
const run = await runScenario(s, () => stubPlanner);

if (run.result.rehearsal) console.log(renderRehearsal(run.result.rehearsal));
console.log(renderVerification(run.result));
console.log(renderSummary(run.result));
console.log("\nORACLE (independent ground truth)");
for (const o of run.oracle) {
  console.log(`  ${o.pass ? "PASS" : "FAIL"}  ${o.assertion.type} ${JSON.stringify(o.observed)}`);
}
console.log(`\nclaimedSuccess=${run.claimedSuccess} groundTruthOk=${run.groundTruthOk} silentFailure=${run.silentFailure} caughtInVerify=${run.caughtInVerify} taskSuccess=${run.taskSuccess}`);
}
main();
