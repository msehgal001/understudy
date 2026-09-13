import type { Check } from "@/core/action";

/**
 * Preconditions. Same rule as postconditions: they read live state. They exist so
 * commit refuses to act on a world that has drifted since rehearsal.
 */

export function githubHasEffectiveAccess(id: { org: string; repo: string; login: string }): Check {
  return {
    id: `pre.gh.has-access:${id.org}/${id.repo}:${id.login}`,
    describe: `${id.login} currently has access to ${id.org}/${id.repo}`,
    async run(ctx) {
      const { permission } = await ctx.adapters.github.getEffectivePermission(id.org, id.repo, id.login);
      return { pass: permission !== "none", observed: { permission } };
    },
  };
}

export function githubIsTeamMember(id: { org: string; slug: string; login: string }): Check {
  return {
    id: `pre.gh.team-member:${id.org}/${id.slug}:${id.login}`,
    describe: `${id.login} is currently a member of team ${id.slug}`,
    async run(ctx) {
      const members = await ctx.adapters.github.listTeamMembers(id.org, id.slug);
      return { pass: members.some((m) => m.login === id.login), observed: { members: members.map((m) => m.login) } };
    },
  };
}

export function driveFileExists(id: { fileId: string }): Check {
  return {
    id: `pre.drive.exists:${id.fileId}`,
    describe: `file ${id.fileId} exists and is not trashed`,
    async run(ctx) {
      const f = await ctx.adapters.drive.getFile(id.fileId);
      return { pass: !!f && !f.trashed, observed: { file: f } };
    },
  };
}

/**
 * Guards the sole-owner case: never hand a resource to someone who is also
 * leaving, and never to an address that is not a real configured successor.
 * An empty successor fails too — "transfer to nobody" is not a transfer.
 */
export function driveSuccessorIsDistinct(id: { successorEmail: string; departingEmail: string }): Check {
  const wellFormed = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id.successorEmail);
  return {
    id: `pre.drive.successor-distinct:${id.successorEmail || "(none)"}`,
    describe: `successor ${id.successorEmail || "(none configured)"} is a real address and is not the departing employee`,
    async run() {
      const ok = wellFormed && id.successorEmail !== id.departingEmail;
      return {
        pass: ok,
        observed: { successorEmail: id.successorEmail, departingEmail: id.departingEmail, wellFormed },
        note: ok ? undefined
          : !id.successorEmail ? "no successor is configured, so there is nobody to transfer to"
          : !wellFormed ? `"${id.successorEmail}" is not a usable email address`
          : "the configured successor is the departing employee",
      };
    },
  };
}

/** The plan named a recipient other than the configured successor. Refuse it. */
export function plannerProposedDifferentRecipient(id: { requested: string; configured: string }): Check {
  return {
    id: `pre.drive.recipient-matches-config:${id.requested}`,
    describe: `the plan's proposed owner "${id.requested}" matches the configured successor`,
    async run() {
      return {
        pass: false,
        observed: { requested: id.requested, configured: id.configured || null },
        note: `the plan proposed transferring ownership to "${id.requested}" but the configured successor is ` +
              `"${id.configured || "(none)"}". Who receives an irreversible transfer is not the planner's decision.`,
      };
    },
  };
}

export function linearIssueIsAssignedTo(id: { issueId: string; assigneeId: string }): Check {
  return {
    id: `pre.linear.assigned:${id.issueId}`,
    describe: `issue ${id.issueId} is currently assigned to ${id.assigneeId}`,
    async run(ctx) {
      const issue = await ctx.adapters.linear.getIssue(id.issueId);
      return { pass: issue?.assigneeId === id.assigneeId, observed: { assigneeId: issue?.assigneeId ?? null } };
    },
  };
}

/**
 * The planner supplies a Linear team id, and a live run showed it inventing one —
 * the write came back "Argument Validation Error". Checking first turns a hard
 * failure into an honest refusal that names the bad id.
 */
export function linearTeamExists(id: { teamId: string }): Check {
  return {
    id: `pre.linear.team-exists:${id.teamId}`,
    describe: `Linear team ${id.teamId} exists`,
    async run(ctx) {
      if (!id.teamId) return { pass: false, observed: { teamId: null }, note: "no Linear team was identified for the audit issue" };
      let team: { id: string } | null = null;
      try {
        team = await ctx.adapters.linear.getTeam(id.teamId);
      } catch (err) {
        return { pass: false, observed: { teamId: id.teamId }, note: `could not look up the team: ${err instanceof Error ? err.message : String(err)}` };
      }
      return {
        pass: !!team,
        observed: { teamId: id.teamId, found: !!team },
        note: team ? undefined : `Linear has no team with id "${id.teamId}" — the audit issue has nowhere to go`,
      };
    },
  };
}
