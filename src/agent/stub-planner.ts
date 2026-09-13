import type { Planner } from "@/core/executor";
import type { PlanDecision } from "@/actions/index";

/**
 * A deterministic planner used for executor tests, offline runs, and as the
 * fallback when no ANTHROPIC_API_KEY is present.
 *
 * It plans exactly what a competent-but-literal operator would: close every grant
 * it can see a record for, transfer what must be transferred first. It does not
 * pre-emptively chase inherited paths — which is precisely the behaviour the
 * verify phase exists to backstop.
 */
export const stubPlanner: Planner = async ({ discovery: d }) => {
  const out: PlanDecision[] = [];
  const push = (p: PlanDecision) => out.push(p);

  // Transfers first, always.
  for (const f of d.drive.files) {
    if (f.soleOwner && d.target.successorEmail) {
      push({
        id: `transfer-${f.id}`, operation: "drive.transferOwnership",
        params: { fileId: f.id, newOwnerEmail: d.target.successorEmail },
        rationale: `${d.target.name} is the only owner of "${f.name}"; ownership must move before access is removed or the file is orphaned.`,
      });
    }
  }

  for (const i of d.linear.issues) {
    // An inactive or missing successor means unassigned, never handed to someone
    // who is themselves on the way out.
    const to = d.linear.successorUserId;
    push({
      id: `reassign-${i.id}`, operation: "linear.reassignIssue",
      params: { issueId: i.id, assigneeId: to, previousAssigneeId: d.linear.userId, identifier: i.identifier },
      rationale: to
        ? `Issue ${i.identifier} moves to the successor.`
        : `Issue ${i.identifier} is left unassigned: no active successor is available to take it.`,
    });
  }

  // Revocations.
  for (const g of d.github.grants) {
    if (g.path.kind !== "direct") continue;
    const repo = g.resourceName.split("/")[1];
    push({
      id: `revoke-gh-${repo}`, operation: "github.removeCollaborator",
      params: { repo, login: d.target.githubLogin, previousPermission: g.permission },
      rationale: `Remove the direct collaborator record on ${g.resourceName}.`,
    });
  }

  for (const f of d.drive.files) {
    const mine = f.permissions.find((p) => p.emailAddress === d.target.email);
    if (!mine) continue;
    push({
      id: `revoke-drive-${f.id}`, operation: "drive.removePermission",
      params: { fileId: f.id, permissionId: mine.id, email: d.target.email, role: mine.role },
      rationale: `Remove ${d.target.email}'s ${mine.role} permission on "${f.name}".`,
    });
  }

  for (const m of d.linear.memberships) {
    push({
      id: `revoke-linear-${m.id}`, operation: "linear.removeTeamMembership",
      params: { membershipId: m.id, teamId: m.teamId, userId: d.linear.userId },
      rationale: `Remove Linear team membership ${m.id}.`,
    });
  }

  const teamId = d.linear.issues[0]?.teamId ?? d.linear.memberships[0]?.teamId;
  if (teamId) {
    push({
      id: "audit-issue", operation: "linear.createAuditIssue",
      params: { teamId, title: `Offboarding audit: ${d.target.name}`, description: `Automated offboarding of ${d.target.email}.` },
      rationale: "Leave an auditable record of the offboarding in the team's tracker.",
    });
  }

  push({
    id: "slack-report", operation: "slack.postReport",
    params: { text: `Offboarding completed for ${d.target.name} (${d.target.email}).` },
    rationale: "Notify the team channel that the offboarding ran.",
  });

  return { decisions: out, summary: "Deterministic plan: transfer sole-owned files, reassign issues, revoke every directly-recorded grant, then report." };
};
