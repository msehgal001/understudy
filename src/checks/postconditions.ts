import type { Check, CheckContext, CheckResult } from "@/core/action";
import { describeGrantPath, type GrantPath } from "@/core/world";

/**
 * Postconditions. Every check in this file answers its question by reading live
 * state back from the API.
 *
 * On the guarantee, stated precisely: TypeScript does not and cannot prevent a
 * postcondition from closing over the response of the write that produced it. If
 * an Action were built as one object literal, `apply` and `postconditions` would
 * share a scope and a captured variable would compile happily. Claiming the type
 * system forbids it would be an overclaim that collapses the moment someone tries.
 *
 * What actually holds, and what is enforced:
 *
 *   1. This module does not import anything from src/actions/. The factories below
 *      receive a resource identity and nothing else, so no write response exists in
 *      lexical scope here to be captured. Actions attach postconditions by calling
 *      these factories; they cannot smuggle a response in.
 *   2. src/checks/postconditions.spy.test.ts runs every factory against a spy
 *      adapter and fails any check that returns a verdict without having issued at
 *      least one read. A check that answered from memory would not survive CI.
 *
 * That is structural separation plus a test, not typed impossibility. It is a
 * weaker claim than "the compiler forbids it" and it is the true one.
 */

export type GithubRepoIdentity = { org: string; repo: string; login: string };

/** The headline check. Effective access, not the absence of a collaborator record. */
export function githubNoEffectiveAccess(id: GithubRepoIdentity): Check {
  return {
    id: `gh.no-access:${id.org}/${id.repo}:${id.login}`,
    describe: `${id.login} has no effective access to ${id.org}/${id.repo}`,
    async run(ctx: CheckContext): Promise<CheckResult> {
      const { permission } = await ctx.adapters.github.getEffectivePermission(id.org, id.repo, id.login);
      if (permission === "none") return { pass: true, observed: { permission: "none" } };

      // Access survived. Re-enumerate to name the surviving path, because the
      // permission endpoint cannot say which grant produced the answer.
      const paths = await surviving(ctx, id);
      return {
        pass: false,
        observed: { permission, survivingPaths: paths.map(describeGrantPath) },
        note:
          `effective permission is "${permission}" via ` +
          (paths.length ? paths.map(describeGrantPath).join(", ") : "an unresolved path"),
      };
    },
  };
}

async function surviving(ctx: CheckContext, id: GithubRepoIdentity): Promise<GrantPath[]> {
  const gh = ctx.adapters.github;
  const out: GrantPath[] = [];

  const direct = await gh.listDirectCollaborators(id.org, id.repo);
  if (direct.some((c) => c.login === id.login)) out.push({ kind: "direct" });

  const membership = await gh.getOrgMembership(id.org, id.login);
  if (membership.state === "active") {
    const teams = await gh.listRepoTeams(id.org, id.repo);
    for (const t of teams) {
      const members = await gh.listTeamMembers(id.org, t.slug);
      if (members.some((m) => m.login === id.login)) out.push({ kind: "team", slug: t.slug });
    }
    const base = await gh.getOrgDefaultRepoPermission(id.org);
    if (base !== "none") out.push({ kind: "org-base" });
  }
  return out;
}

export function githubNotTeamMember(id: { org: string; slug: string; login: string }): Check {
  return {
    id: `gh.not-team-member:${id.org}/${id.slug}:${id.login}`,
    describe: `${id.login} is not a member of team ${id.slug}`,
    async run(ctx) {
      const members = await ctx.adapters.github.listTeamMembers(id.org, id.slug);
      const present = members.some((m) => m.login === id.login);
      return { pass: !present, observed: { members: members.map((m) => m.login) } };
    },
  };
}

export function githubNotOrgMember(id: { org: string; login: string }): Check {
  return {
    id: `gh.not-org-member:${id.org}:${id.login}`,
    describe: `${id.login} is not an active member of ${id.org}`,
    async run(ctx) {
      const m = await ctx.adapters.github.getOrgMembership(id.org, id.login);
      return { pass: m.state === "none", observed: m };
    },
  };
}

/**
 * Drive access is not one record. A user permission can be gone while an
 * `anyone`-with-link permission still grants the world access, including the
 * departing employee. Both are checked.
 */
export function driveNoAccess(id: { fileId: string; email: string }): Check {
  return {
    id: `drive.no-access:${id.fileId}:${id.email}`,
    describe: `${id.email} has no access to file ${id.fileId}`,
    async run(ctx) {
      const perms = await ctx.adapters.drive.listPermissions(id.fileId);
      const userPerm = perms.find((p) => p.emailAddress === id.email);
      const linkPerm = perms.find((p) => p.type === "anyone");
      const surviving: string[] = [];
      if (userPerm) surviving.push(describeGrantPath({ kind: "direct" }));
      if (linkPerm) surviving.push(describeGrantPath({ kind: "link-sharing", scope: "anyone" }));
      return {
        pass: surviving.length === 0,
        observed: { permissions: perms.map((p) => ({ id: p.id, type: p.type, role: p.role, email: p.emailAddress })), surviving },
        note: surviving.length ? `access survives via ${surviving.join(", ")}` : undefined,
      };
    },
  };
}

export function driveOwnedBy(id: { fileId: string; email: string }): Check {
  return {
    id: `drive.owned-by:${id.fileId}:${id.email}`,
    describe: `file ${id.fileId} is owned by ${id.email}`,
    async run(ctx) {
      const file = await ctx.adapters.drive.getFile(id.fileId);
      return { pass: file?.ownerEmail === id.email, observed: { ownerEmail: file?.ownerEmail ?? null } };
    },
  };
}

export function linearIssueAssignedTo(id: { issueId: string; assigneeId: string | null }): Check {
  return {
    id: `linear.assigned:${id.issueId}`,
    describe: `issue ${id.issueId} is assigned to ${id.assigneeId ?? "nobody"}`,
    async run(ctx) {
      const issue = await ctx.adapters.linear.getIssue(id.issueId);
      return { pass: (issue?.assigneeId ?? null) === id.assigneeId, observed: { assigneeId: issue?.assigneeId ?? null } };
    },
  };
}

export function linearNotTeamMember(id: { userId: string; teamId: string }): Check {
  return {
    id: `linear.not-team-member:${id.teamId}:${id.userId}`,
    describe: `user ${id.userId} is not a member of team ${id.teamId}`,
    async run(ctx) {
      const memberships = await ctx.adapters.linear.listTeamMemberships(id.userId);
      const present = memberships.some((m) => m.teamId === id.teamId);
      return { pass: !present, observed: { teamIds: memberships.map((m) => m.teamId) } };
    },
  };
}

export function slackMessagePosted(id: { channel: string; contains: string }): Check {
  return {
    id: `slack.posted:${id.channel}`,
    describe: `a message containing "${id.contains}" is present in ${id.channel}`,
    async run(ctx) {
      // A thrown UnverifiableError propagates to the executor, which records the
      // check as "could not determine" rather than "the message is missing".
      const msgs = await ctx.adapters.slack.listMessages(id.channel);
      const hit = msgs.some((m) => m.text.includes(id.contains));
      return { pass: hit, observed: { recent: msgs.slice(0, 3).map((m) => m.ts) } };
    },
  };
}

/** Every factory in this module, for the spy test to enumerate. */
export const ALL_POSTCONDITION_FACTORIES = {
  githubNoEffectiveAccess: () => githubNoEffectiveAccess({ org: "o", repo: "r", login: "u" }),
  githubNotTeamMember: () => githubNotTeamMember({ org: "o", slug: "t", login: "u" }),
  githubNotOrgMember: () => githubNotOrgMember({ org: "o", login: "u" }),
  driveNoAccess: () => driveNoAccess({ fileId: "f", email: "u@x.com" }),
  driveOwnedBy: () => driveOwnedBy({ fileId: "f", email: "u@x.com" }),
  linearIssueAssignedTo: () => linearIssueAssignedTo({ issueId: "i", assigneeId: null }),
  linearNotTeamMember: () => linearNotTeamMember({ userId: "u", teamId: "t" }),
  slackMessagePosted: () => slackMessagePosted({ channel: "#c", contains: "x" }),
  linearIssueExists: () => linearIssueExists(() => "iss-1"),
};

/**
 * A created resource can only be re-read once you know its id, so this factory
 * takes an id *provider* rather than an id. The verdict still comes from a fresh
 * read — the provider supplies an address, not an answer. That distinction is the
 * whole rule: using the write's response to locate the resource is fine, using it
 * to decide pass/fail is not.
 */
export function linearIssueExists(getId: () => string | null): Check {
  return {
    id: "linear.issue-exists",
    describe: "the audit issue exists when read back by id",
    async run(ctx) {
      const id = getId();
      if (!id) return { pass: false, observed: { issueId: null }, note: "no issue id was produced" };
      const issue = await ctx.adapters.linear.getIssue(id);
      return { pass: !!issue, observed: { issueId: id, identifier: issue?.identifier ?? null } };
    },
  };
}
