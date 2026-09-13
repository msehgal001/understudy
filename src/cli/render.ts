import type { RunResult } from "@/core/executor";
import { describeGrantPath, type Grant } from "@/core/world";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", amber: "\x1b[33m", cyan: "\x1b[36m", grey: "\x1b[90m",
};
const on = process.stdout.isTTY || process.env.FORCE_COLOR === "1";
const c = (code: string, s: string) => (on ? `${code}${s}${C.reset}` : s);

export const green = (s: string) => c(C.green, s);
export const red = (s: string) => c(C.red, s);
export const amber = (s: string) => c(C.amber, s);
export const dim = (s: string) => c(C.grey, s);
export const bold = (s: string) => c(C.bold, s);
export const mono = (s: string) => c(C.cyan, s);

function rule(title: string) {
  return `\n${bold(title)}\n${dim("─".repeat(Math.max(24, title.length)))}`;
}

const grantLine = (g: Grant) => `${mono(g.resourceName)}  ${g.permission.padEnd(8)} ${dim("via")} ${mono(describeGrantPath(g.path))}`;

export function renderRehearsal(r: NonNullable<RunResult["rehearsal"]>): string {
  const out: string[] = [];
  out.push(rule("REHEARSAL  (shadow adapter — nothing touched production)"));

  out.push(`\n${bold("Actions")}`);
  for (const e of r.entries) {
    const mark = e.ok ? green("✓") : e.error ? red("✗") : amber("!");
    const rev = e.reversible ? dim("reversible") : amber("IRREVERSIBLE — needs approval");
    out.push(`  ${mark} ${e.description}`);
    out.push(`    ${dim(e.app.padEnd(7))} ${dim(e.kind.padEnd(9))} ${rev}`);
    if (e.applied) out.push(`    ${dim(`write returned ${e.applied.status}`)}`);
    for (const p of e.postconditions) {
      const m = p.result.pass ? green("✓") : red("✗");
      out.push(`      ${m} ${dim("postcondition")} ${p.describe}`);
      if (!p.result.pass && p.result.note) out.push(`        ${red(p.result.note)}`);
    }
    if (e.error) out.push(`    ${red(e.error)}`);
  }

  out.push(`\n${bold("Access diff")}`);
  if (r.removed.length) {
    out.push(green(`  removed (${r.removed.length})`));
    for (const g of r.removed) out.push(`    ${green("−")} ${grantLine(g)}`);
  }
  if (r.remaining.length) {
    out.push(red(`  STILL STANDING AFTER THE PLAN (${r.remaining.length})`));
    for (const g of r.remaining) out.push(`    ${red("!")} ${grantLine(g)}`);
  } else {
    out.push(green("  nothing remains"));
  }
  return out.join("\n");
}

export function renderVerification(r: RunResult): string {
  const out: string[] = [];
  out.push(rule("VERIFY  (independent live re-read)"));

  if (!r.verification.checks.length) {
    out.push(red("\n  no postconditions were evaluated"));
    return out.join("\n");
  }

  for (const chk of r.verification.checks) {
    const m = chk.result.pass ? green("✓") : red("✗");
    out.push(`  ${m} ${chk.describe}`);
    out.push(`    ${dim(`observed: ${JSON.stringify(chk.result.observed)}`)}`);
  }

  // Every postcondition that failed at any point in verify, whether or not
  // remediation later closed it. A catch that got fixed is still a catch — it is
  // the thing that would otherwise have shipped as a clean report.
  const seenCaught = new Set<string>();
  const caught = r.verification.checks
    .filter((c) => !c.result.pass && !c.result.unverifiable)
    .filter((c) => (seenCaught.has(c.checkId) ? false : (seenCaught.add(c.checkId), true)));
  const unknown = r.verification.checks.filter((c) => c.result.unverifiable);
  const unresolved = new Set(r.verification.failures.map((f) => f.checkId));

  if (caught.length) {
    out.push(`\n${red(bold("  ── SILENT FAILURE CAUGHT ──"))}`);
    for (const f of caught) {
      const obs = f.result.observed as { permission?: string; survivingPaths?: string[]; surviving?: string[] } | null;
      const commit = r.commits.find((x) => x.actionId === f.actionId);
      const state = unresolved.has(f.checkId) ? red("STILL OPEN") : green("closed by remediation");
      out.push(`\n  ${bold(f.describe)}   ${state}`);
      if (commit?.applied) out.push(`    the write said   ${green(String(commit.applied.status))}  ${dim("(success)")}`);
      out.push(`    the re-read said ${red(obs?.permission ?? "access persists")}`);
      const paths = obs?.survivingPaths ?? obs?.surviving ?? [];
      if (paths.length) out.push(`    surviving path   ${mono(paths.join(", "))}`);
      if (f.result.note) out.push(`    ${red(f.result.note)}`);
    }
  } else {
    out.push(`\n  ${green("no discrepancies: every write was confirmed by an independent read")}`);
  }

  if (unknown.length) {
    out.push(`\n${amber(bold("  ── COULD NOT VERIFY ──"))}`);
    out.push(`  ${dim("these are not failures. nobody knows, and unknown is not success.")}`);
    for (const u of unknown) {
      out.push(`\n  ${bold(u.describe)}`);
      out.push(`    ${amber(u.result.note ?? "the read could not be performed")}`);
    }
  }

  if (r.remediationRounds) out.push(`\n  ${amber(`${r.remediationRounds} remediation round(s) ran`)}`);
  return out.join("\n");
}

export function renderSummary(r: RunResult): string {
  const colour = r.status === "verified" ? green : r.status === "unresolved" ? red : amber;
  const lines = [
    rule("RUN SUMMARY"),
    `  run        ${mono(r.runId)}`,
    `  status     ${colour(bold(r.status.toUpperCase()))}`,
    `  ${r.summary}`,
    `  actions    ${r.commits.filter((x) => x.status === "applied").length} applied, ` +
      `${r.commits.filter((x) => x.status === "skipped-idempotent").length} skipped (idempotent), ` +
      `${r.commits.filter((x) => x.status === "failed").length} failed`,
    `  approvals  ${r.approvals.granted.length}/${r.approvals.required.length} granted`,
    `  tokens     ${r.tokens.input} in / ${r.tokens.output} out   cost $${r.costUsd.toFixed(4)}   ${r.durationMs}ms`,
  ];
  if (r.rollback) {
    lines.push(`  rollback   ${r.rollback.succeeded.length} undone, ${r.rollback.failed.length} failed`);
    if (r.rollback.irreversibleLeftInPlace.length) {
      lines.push(`  ${amber(`irreversible, left in place: ${r.rollback.irreversibleLeftInPlace.join(", ")}`)}`);
    }
  }
  return lines.join("\n");
}
