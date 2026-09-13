import type { Discovery } from "@/core/discover";
import { describeGrantPath } from "@/core/world";
import { OPERATION_NAMES } from "@/actions/index";

export const PLANNER_SYSTEM = `You are the planning stage of an automated offboarding system.

You are given a complete read-only survey of everything a departing employee can
still reach across GitHub, Google Drive, Linear and Slack. You decide, per
resource, whether to revoke, transfer, or archive, and in what order.

What you must know about the system you are part of:

- You do not perform any writes. You emit a plan. A separate executor rehearses
  every action against a simulator, requires human approval for anything
  irreversible, commits, and then independently re-reads live state to check that
  what you intended actually happened.
- Because verification is independent, a plan that looks complete but leaves an
  indirect grant standing will be caught and reported. Do not optimise for a plan
  that appears clean. Optimise for one that survives a re-read.
- Access is frequently held through more than one path at once. The survey names
  the path of every grant: direct, team:<slug>, org-base, link-sharing, group.
  Removing a direct collaborator record does not remove team-derived access, and
  removing one user's Drive permission does not remove an "anyone with the link"
  permission. If a resource is reachable by two paths, plan an action for each.
- An "anyone with the link" permission is access the departing employee still
  holds. It is not exempt because it is impersonal. If a file genuinely must stay
  publicly reachable, plan the removal anyway and say in the rationale that a
  human should decide whether to restore public sharing afterwards — do not leave
  it in place and describe the offboarding as complete.

Ordering rules, enforced in code after you answer:

- Every transfer of a resource must come before any revocation on that same
  resource. A file whose only owner is departing must be transferred first, or it
  is orphaned. If you get this wrong your plan is rejected and you are asked again.
- Never transfer a resource to someone who is also departing.

Judgement rules:

- If the departing employee is the sole owner of a Drive file, transfer ownership
  to the successor before removing their access.
- Reassign their open Linear issues to the successor. If the successor is not a
  valid target, leave the issue unassigned rather than assigning it to someone who
  is also leaving, and say so in the rationale.
- Always finish with an audit issue in Linear and a report posted to Slack.
- Prefer the narrowest action that closes the access. Removing someone from the
  whole organisation is a last resort and is irreversible; it will be held for
  human approval.

Write a rationale for every decision in one sentence. The rationale is read by a
human during approval and by an auditor afterwards, so state what the action does
and why, not that it is important.`;

export function plannerUserMessage(d: Discovery, violations?: { message: string }[], previous?: unknown): string {
  const lines: string[] = [];
  lines.push(`Departing employee: ${d.target.name} <${d.target.email}> (GitHub: ${d.target.githubLogin})`);
  lines.push(`Successor for transfers: ${d.target.successorEmail || "(none configured)"} (GitHub: ${d.target.successorGithubLogin || "n/a"})`);
  lines.push("");
  lines.push(`## GitHub (org: ${d.org})`);
  lines.push(`Organization membership: ${d.github.orgMembership.state} (${d.github.orgMembership.role})`);
  if (!d.github.grants.length) lines.push("No GitHub grants found.");
  for (const g of d.github.grants) {
    lines.push(`- ${g.resourceName}: ${g.permission} via ${describeGrantPath(g.path)}`);
  }
  if (d.github.teams.length) lines.push(`Teams containing this user: ${d.github.teams.join(", ")}`);

  lines.push("");
  lines.push("## Google Drive");
  if (!d.drive.files.length) lines.push("No Drive files found.");
  for (const f of d.drive.files) {
    const flags = [
      f.departingIsOwner ? "departing-is-owner" : null,
      f.soleOwner ? "SOLE-OWNER" : null,
      f.linkSharing ? "link-sharing:anyone" : null,
    ].filter(Boolean).join(", ");
    lines.push(`- ${f.id} "${f.name}" owner=${f.ownerEmail}${flags ? ` [${flags}]` : ""}`);
    for (const p of f.permissions) {
      lines.push(`    permission ${p.id}: type=${p.type} role=${p.role}${p.emailAddress ? ` email=${p.emailAddress}` : ""}`);
    }
  }

  lines.push("");
  lines.push("## Linear");
  lines.push(`User id: ${d.linear.userId ?? "(not found)"}`);
  lines.push(`Successor Linear user id: ${d.linear.successorUserId ?? "(none available — an inactive or missing successor means issues should be left unassigned)"}`);
  for (const i of d.linear.issues) lines.push(`- issue ${i.id} (${i.identifier}) "${i.title}" team=${i.teamId} state=${i.state}`);
  for (const m of d.linear.memberships) lines.push(`- team membership ${m.id} team=${m.teamId}`);

  lines.push("");
  lines.push("## Available operations");
  lines.push(OPERATION_NAMES.map((n) => `- ${n}`).join("\n"));

  if (violations?.length) {
    lines.push("");
    lines.push("## YOUR PREVIOUS PLAN WAS REJECTED");
    lines.push("The ordering invariant is enforced in code. Fix the order and resubmit the full plan.");
    for (const v of violations) lines.push(`- ${v.message}`);
    lines.push("");
    lines.push("Previous plan:");
    lines.push(JSON.stringify(previous, null, 2));
  }

  return lines.join("\n");
}
