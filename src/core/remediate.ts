import type { PlanDecision } from "@/actions/index";
import type { CheckResult } from "@/core/action";

export type VerificationFailure = {
  actionId: string;
  checkId: string;
  describe: string;
  result: CheckResult;
};

/**
 * Turn a failed postcondition into the actions that would actually close the gap.
 *
 * This is deterministic, not a model call. When verify catches surviving access
 * the observed value already names the path — `team:payments`, `link-sharing:anyone`,
 * `org-base` — so the fix is a lookup, and a lookup cannot hallucinate a repo name
 * at the exact moment the system is trying to prove it is honest.
 */
export function remediationsFor(f: VerificationFailure, ctx: { org: string; login: string; email: string }): PlanDecision[] {
  const obs = f.result.observed as Record<string, unknown> | null;
  const out: PlanDecision[] = [];

  // ---- github: effective access survived a revoke
  if (f.checkId.startsWith("gh.no-access:")) {
    const repo = f.checkId.split(":")[1]?.split("/")[1] ?? "";
    const paths = (obs?.survivingPaths as string[]) ?? [];

    for (const p of paths) {
      if (p.startsWith("team:")) {
        const slug = p.slice("team:".length);
        out.push({
          id: `remediate-team-${slug}-${repo}`,
          operation: "github.removeTeamMember",
          params: { slug, login: ctx.login, repo },
          rationale: `Verify found admin surviving through team "${slug}" after the direct collaborator record was removed. The 204 from the collaborator delete described only the direct grant.`,
        });
      } else if (p === "direct") {
        out.push({
          id: `remediate-direct-${repo}`,
          operation: "github.removeCollaborator",
          params: { repo, login: ctx.login },
          rationale: "A direct collaborator record is still present after the revoke.",
        });
      } else if (p === "org-base") {
        // Deliberately NOT auto-remediated: the fix is either an org-wide settings
        // change or removing the person from the org entirely, and both are far
        // wider in blast radius than the action that failed. Escalate instead.
        out.push({
          id: `remediate-org-${ctx.login}`,
          operation: "github.removeOrgMember",
          params: { login: ctx.login },
          rationale: `Access survives through the organization's default repository permission, which grants every member access to ${repo} with no collaborator or team record at all. Removing org membership is the only per-user fix and it is irreversible, so it requires approval.`,
        });
      }
    }
  }

  // ---- github: team membership survived, with or without a repo grant attached
  if (f.checkId.startsWith("gh.not-team-member:")) {
    const slug = f.checkId.split(":")[1]?.split("/")[1] ?? "";
    if (slug) {
      out.push({
        id: `remediate-team-${slug}`,
        operation: "github.removeTeamMember",
        params: { slug, login: ctx.login },
        rationale: `Verify found the departing user still on team "${slug}". The team may grant no repository access today, which is exactly why nothing else flags it, and exactly why it is worth closing.`,
      });
    }
  }

  // ---- drive: access survived a permission delete
  if (f.checkId.startsWith("drive.no-access:")) {
    const fileId = f.checkId.split(":")[1] ?? "";
    const surviving = (obs?.surviving as string[]) ?? [];
    const perms = (obs?.permissions as { id: string; type: string; role: string; email?: string }[]) ?? [];

    if (surviving.some((s) => s.startsWith("link-sharing"))) {
      const anyone = perms.find((p) => p.type === "anyone");
      if (anyone) {
        out.push({
          id: `remediate-link-${fileId}`,
          operation: "drive.removePermission",
          params: { fileId, permissionId: anyone.id, email: ctx.email, role: anyone.role },
          rationale: `The user permission was deleted but an "anyone with the link" permission is a separate ACL record and still grants access to this file.`,
        });
      }
    }
    const still = perms.find((p) => p.email === ctx.email);
    if (still && still.role !== "owner") {
      out.push({
        id: `remediate-drive-${fileId}`,
        operation: "drive.removePermission",
        params: { fileId, permissionId: still.id, email: ctx.email, role: still.role },
        rationale: "A user permission for the departing employee is still present after the delete.",
      });
    }
    // An owner permission is deliberately NOT auto-remediated. Deleting the only
    // owner's access orphans the file: nobody can administer it, and the fix is
    // worse than the finding. This needs ownership transferred by a human first,
    // so the check stays failing and the run stays unresolved — visibly.

  }

  return out;
}
