import type { Action, ActionContext } from "@/core/action";
import { irreversible } from "@/core/action";
import type { OffboardTarget } from "@/core/config";
import type { GithubPermission } from "@/core/world";
import * as post from "@/checks/postconditions";
import * as pre from "@/checks/preconditions";

/**
 * What the agent is allowed to decide. The model emits PlanDecisions; this module
 * turns them into Actions. The model never constructs an Action, never chooses a
 * postcondition, and never sets `reversible` — those are properties of the
 * operation, not of the plan, so a persuasive-sounding plan cannot talk its way
 * past an approval gate.
 */
export type PlanDecision = {
  id: string;
  operation: OperationName;
  params: Record<string, string | number | null>;
  rationale: string;
};

export type BuildContext = {
  org: string;
  target: OffboardTarget;
  slackChannel: string;
  /**
   * Where the audit issue is filed. Same rule as slackChannel and the transfer
   * recipient: resolved from the workspace or from configuration, never chosen by
   * the planner. A live run had the model file the audit issue into a Linear team
   * called "payments" — the GitHub team slug — which does not exist in Linear. The
   * precondition caught it and refused, so nothing was written to the wrong place,
   * but the run ended `unresolved` over a detail the model had no way to know.
   */
  auditTeamId?: string;
};

/**
 * Repository names arrive either bare ("payments-core") or org-qualified
 * ("acme-co/payments-core"), depending on how the model reads the survey — which
 * prints them qualified. Passing a qualified name straight through produces
 * `/repos/acme-co/acme-co%2Fpayments-core/...`, every precondition fails, and the
 * revoke silently never runs.
 *
 * Telling the model not to do it works most of the time, and most of the time is
 * not a reliability property. Normalising here does not depend on the model
 * reading a schema description correctly.
 */
export function bareRepo(value: unknown, org: string): string {
  const raw = String(value ?? "").trim();
  const prefix = `${org}/`;
  if (raw.toLowerCase().startsWith(prefix.toLowerCase())) return raw.slice(prefix.length);
  // Any other "owner/name" shape: take the last segment.
  const parts = raw.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : raw;
}

type Builder = (p: Record<string, never>, ctx: BuildContext, id: string) => Action;

const OPERATIONS = {
  "github.removeCollaborator": (p, ctx, id) => {
    const repo = bareRepo(p.repo, ctx.org), login = String(p.login);
    const previous = (String(p.previousPermission ?? "push") || "push") as GithubPermission;
    return {
      id, app: "github", kind: "revoke",
      description: `Remove ${login} as a direct collaborator on ${ctx.org}/${repo}`,
      reversible: true,
      idempotencyKey: `gh:rm-collab:${ctx.org}/${repo}:${login}`,
      resourceId: `github:${ctx.org}/${repo}`,
      preconditions: [pre.githubHasEffectiveAccess({ org: ctx.org, repo, login })],
      // Not "the collaborator record is gone" — effective access, which is the
      // question the 204 pretends to have answered.
      postconditions: [post.githubNoEffectiveAccess({ org: ctx.org, repo, login })],
      apply: (c: ActionContext) => c.adapters.github.removeCollaborator(ctx.org, repo, login),
      inverse: async (c: ActionContext) => {
        await c.adapters.github.addCollaborator(ctx.org, repo, login, previous);
      },
    };
  },

  "github.removeTeamMember": (p, ctx, id) => {
    const slug = String(p.slug), login = String(p.login);
    const repo = p.repo ? bareRepo(p.repo, ctx.org) : null;
    return {
      id, app: "github", kind: "revoke",
      description: `Remove ${login} from team ${slug}`,
      reversible: true,
      idempotencyKey: `gh:rm-team:${ctx.org}/${slug}:${login}`,
      resourceId: repo ? `github:${ctx.org}/${repo}` : `github:team:${slug}`,
      preconditions: [pre.githubIsTeamMember({ org: ctx.org, slug, login })],
      postconditions: [
        post.githubNotTeamMember({ org: ctx.org, slug, login }),
        ...(repo ? [post.githubNoEffectiveAccess({ org: ctx.org, repo, login })] : []),
      ],
      apply: (c: ActionContext) => c.adapters.github.removeTeamMember(ctx.org, slug, login),
      inverse: async (c: ActionContext) => {
        await c.adapters.github.addTeamMember(ctx.org, slug, login, "member");
      },
    };
  },

  /**
   * Irreversible on purpose. Re-adding someone to an org creates a *pending*
   * invitation that only they can accept, so an automated undo cannot restore the
   * prior state. That makes this an approval gate, not a rollback candidate.
   */
  "github.removeOrgMember": (p, ctx, id) => {
    const login = String(p.login);
    return {
      id, app: "github", kind: "revoke",
      description: `Remove ${login} from the ${ctx.org} organization`,
      reversible: false,
      idempotencyKey: `gh:rm-org:${ctx.org}:${login}`,
      resourceId: `github:org:${ctx.org}`,
      preconditions: [],
      postconditions: [post.githubNotOrgMember({ org: ctx.org, login })],
      apply: (c: ActionContext) => c.adapters.github.removeOrgMember(ctx.org, login),
      inverse: irreversible(id),
    };
  },

  "drive.removePermission": (p, ctx, id) => {
    const fileId = String(p.fileId), permissionId = String(p.permissionId);
    const email = String(p.email ?? ctx.target.email);
    const role = (String(p.role ?? "reader") || "reader") as "writer" | "reader" | "commenter";
    return {
      id, app: "drive", kind: "revoke",
      description: `Remove ${email}'s ${role} access to file ${fileId}`,
      reversible: true,
      idempotencyKey: `drive:rm-perm:${fileId}:${permissionId}`,
      resourceId: `drive:${fileId}`,
      preconditions: [pre.driveFileExists({ fileId })],
      postconditions: [post.driveNoAccess({ fileId, email })],
      apply: (c: ActionContext) => c.adapters.drive.deletePermission(fileId, permissionId),
      inverse: async (c: ActionContext) => {
        await c.adapters.drive.createPermission(fileId, { type: "user", role, emailAddress: email });
      },
    };
  },

  /** Irreversible: Drive will not hand ownership back without the new owner acting. */
  "drive.transferOwnership": (p, ctx, id) => {
    const fileId = String(p.fileId);
    // The recipient comes from configuration, never from the plan.
    //
    // A live eval run earned this line: with the successor deliberately
    // misconfigured as the departing employee, the model did not refuse — it
    // invented a recipient ("<UNKNOWN>") and transferred the file there. The
    // distinctness precondition passed, because "<UNKNOWN>" is indeed distinct
    // from the departing address. Narrowing the check would have been chasing the
    // symptom: who receives an irreversible transfer is simply not a decision the
    // planner gets to make. A mismatch is now surfaced rather than honoured.
    const requested = p.newOwnerEmail ? String(p.newOwnerEmail) : "";
    const newOwner = ctx.target.successorEmail;
    const mismatch = requested && requested !== newOwner;
    return {
      id, app: "drive", kind: "transfer",
      description: `Transfer ownership of file ${fileId} to ${newOwner}`,
      reversible: false,
      idempotencyKey: `drive:transfer:${fileId}:${newOwner}`,
      resourceId: `drive:${fileId}`,
      preconditions: [
        pre.driveFileExists({ fileId }),
        pre.driveSuccessorIsDistinct({ successorEmail: newOwner, departingEmail: ctx.target.email }),
        ...(mismatch ? [pre.plannerProposedDifferentRecipient({ requested, configured: newOwner })] : []),
      ],
      postconditions: [post.driveOwnedBy({ fileId, email: newOwner })],
      apply: (c: ActionContext) => c.adapters.drive.transferOwnership(fileId, newOwner),
      inverse: irreversible(id),
    };
  },

  "linear.reassignIssue": (p, ctx, id) => {
    const issueId = String(p.issueId);
    const to = p.assigneeId === null || p.assigneeId === undefined ? null : String(p.assigneeId);
    const from = String(p.previousAssigneeId ?? "");
    return {
      id, app: "linear", kind: "transfer",
      description: `Reassign issue ${p.identifier ?? issueId} to ${to ?? "nobody"}`,
      reversible: true,
      idempotencyKey: `linear:reassign:${issueId}:${to ?? "none"}`,
      resourceId: `linear:${issueId}`,
      preconditions: from ? [pre.linearIssueIsAssignedTo({ issueId, assigneeId: from })] : [],
      postconditions: [post.linearIssueAssignedTo({ issueId, assigneeId: to })],
      apply: (c: ActionContext) => c.adapters.linear.reassignIssue(issueId, to),
      inverse: async (c: ActionContext) => {
        await c.adapters.linear.reassignIssue(issueId, from || null);
      },
    };
  },

  "linear.removeTeamMembership": (p, ctx, id) => {
    const membershipId = String(p.membershipId), teamId = String(p.teamId);
    const userId = String(p.userId);
    return {
      id, app: "linear", kind: "revoke",
      description: `Remove ${ctx.target.name} from Linear team ${teamId}`,
      reversible: true,
      idempotencyKey: `linear:rm-team:${membershipId}`,
      resourceId: `linear:team:${teamId}`,
      preconditions: [],
      postconditions: [post.linearNotTeamMember({ userId, teamId })],
      apply: (c: ActionContext) => c.adapters.linear.removeTeamMembership(membershipId),
      inverse: async (c: ActionContext) => {
        await c.adapters.linear.addTeamMembership(teamId, userId);
      },
    };
  },

  "linear.createAuditIssue": (p, ctx, id) => {
    const teamId = ctx.auditTeamId ?? String(p.teamId);
    const title = String(p.title ?? `Offboarding audit: ${ctx.target.name}`);
    const description = String(p.description ?? "");
    let createdId: string | null = null;
    return {
      id, app: "linear", kind: "notify",
      description: `Create audit issue "${title}"`,
      reversible: true,
      idempotencyKey: `linear:audit:${teamId}:${ctx.target.githubLogin}`,
      resourceId: `linear:audit:${teamId}`,
      preconditions: [pre.linearTeamExists({ teamId })],
      postconditions: [post.linearIssueExists(() => createdId)],
      apply: async (c: ActionContext) => {
        const res = await c.adapters.linear.createIssue({ teamId, title, description });
        const body = res.body as { issue?: { id?: string } } | null;
        createdId = body?.issue?.id ?? null;
        return res;
      },
      inverse: async (c: ActionContext) => {
        if (createdId) await c.adapters.linear.archiveIssue(createdId);
      },
    };
  },

  "slack.postReport": (p, ctx, id) => {
    // Same rule as the transfer recipient: where the report goes is configured,
    // not chosen by the planner. A live run had the model pick "#offboarding"
    // while SLACK_CHANNEL pointed somewhere else entirely, and the post 400'd.
    const channel = ctx.slackChannel;
    const text = String(p.text ?? "");
    const marker = String(p.marker ?? `offboarding:${ctx.target.githubLogin}`);
    let ts: string | null = null;
    return {
      id, app: "slack", kind: "notify",
      description: `Post the offboarding report to ${channel}`,
      reversible: true,
      idempotencyKey: `slack:report:${channel}:${ctx.target.githubLogin}`,
      resourceId: `slack:${channel}`,
      preconditions: [],
      postconditions: [post.slackMessagePosted({ channel, contains: marker })],
      apply: async (c: ActionContext) => {
        const res = await c.adapters.slack.postMessage(channel, `${text}\n\n\`${marker}\``);
        const body = res.body as { ts?: string } | null;
        ts = body?.ts ?? null;
        return res;
      },
      inverse: async (c: ActionContext) => {
        if (ts) await c.adapters.slack.deleteMessage(channel, ts);
      },
    };
  },
} satisfies Record<string, Builder>;

export type OperationName = keyof typeof OPERATIONS;
export const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[];

export function materialize(decisions: PlanDecision[], ctx: BuildContext): Action[] {
  return decisions.map((d) => {
    const build = OPERATIONS[d.operation] as Builder | undefined;
    if (!build) throw new Error(`unknown operation: ${d.operation}`);
    // The plan schema is strict, so the model sends every known parameter with
    // null for the ones its operation does not use. Strip them here so builders
    // see an absent key rather than the string "null".
    const params = Object.fromEntries(
      Object.entries(d.params ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ""),
    );
    return build(params as Record<string, never>, ctx, d.id);
  });
}
