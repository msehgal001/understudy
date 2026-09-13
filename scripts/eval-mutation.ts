import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MUTANTS } from "@/eval/mutate";
import { green, red, dim, bold } from "@/cli/render";

/**
 * Mutation testing for the eval.
 *
 * Breaks one safety check at a time and requires the suite to notice. A mutant
 * that SURVIVES means the corpus never exercises that check, so a green run
 * proves nothing about it. This is the test that would have caught our own
 * headline number being decoration.
 */
const results: { id: string; describe: string; killed: boolean }[] = [];

console.log(`\n${bold("MUTATION TESTING")}  ${dim("break a check on purpose; the eval must go red")}\n`);

for (const m of MUTANTS) {
  const r = spawnSync(
    "npx",
    ["tsx", "scripts/eval.ts", "--planner=naive", `--mutate=${m.id}`, "--quiet"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const killed = r.status !== 0; // non-zero means the suite detected the damage
  results.push({ ...m, killed });
  console.log(`  ${killed ? green("KILLED  ") : red("SURVIVED")}  ${m.id.padEnd(22)} ${dim(m.describe)}`);
}

// Fold the outcome into eval-report.json so the console and the README quote a
// measured result rather than a claim.
const reportPath = path.join(process.cwd(), "eval-report.json");
if (fs.existsSync(reportPath)) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report.mutation = results.map((r) => ({ mutant: r.id, describe: r.describe, killed: r.killed }));
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}

const survivors = results.filter((r) => !r.killed);
console.log(`\n  ${results.length - survivors.length}/${results.length} mutants killed`);
if (survivors.length) {
  console.log(`  ${red("A surviving mutant means the suite cannot detect that check being broken.")}`);
  console.log(`  ${dim("Add a scenario whose ground truth is unreachable without that check.")}\n`);
  process.exit(1);
}
console.log(`  ${green("Every mutant was killed. The suite can fail.")}\n`);
