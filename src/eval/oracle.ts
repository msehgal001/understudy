import type { Assertion } from "@/eval/types";
import type { WorldState, GithubPermission } from "@/core/world";

/**
 * Ground truth.
 *
 * This module is the reason the silent-failure number means anything. It never
 * calls a Check, never imports src/checks/, and never reads the agent's trace or
 * summary. It looks at the final world and answers, independently, whether the
 * departing employee can still get in.
 *
 * The GitHub permission resolution below is a second, deliberately separate
 * implementation of the same documented rule the shadow adapter implements. If
 * both sides shared one function, a bug in it would make the agent's checks and
 * the ground truth agree with each other while both were wrong — and the headline
 * metric would be measuring nothing but its own reflection.
 */

const RANK: Record<string, number> = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };

/** Independent resolver: highest of direct, team-derived, and org base permission. */
export function effectiveGithubPermission(w: WorldState, repo: string, login: string): GithubPermission {
  const g = w.github;
  const candidates: string[] = ["none"];

  for (const c of g.directCollaborators) {
    if (c.repo === repo && c.login === login) candidates.push(c.permission);
  }

  const isActiveMember = g.orgMembers.some((m) => m.login === login && m.state === "active");
  if (isActiveMember) {
    const userTeams = g.teamMembers.filter((m) => m.login === login).map((m) => m.slug);
    for (const tr of g.teamRepos) {
      if (tr.repo === repo && userTeams.includes(tr.slug)) candidates.push(tr.permission);
    }
    candidates.push(g.defaultRepoPermission);
  }

  return candidates.reduce((best, p) => (RANK[p] > RANK[best] ? p : best), "none") as GithubPermission;
}

export type AssertionResult = { assertion: Assertion; pass: boolean; observed: unknown };

export function evaluate(assertions: Assertion[], final: WorldState, initial: WorldState): AssertionResult[] {
  return assertions.map((a) => {
    switch (a.type) {
      case "github-no-access": {
        const p = effectiveGithubPermission(final, a.repo, a.login);
        return { assertion: a, pass: p === "none", observed: { permission: p } };
      }
      case "github-has-access": {
        const p = effectiveGithubPermission(final, a.repo, a.login);
        const ok = a.atLeast ? RANK[p] >= RANK[a.atLeast] : p !== "none";
        return { assertion: a, pass: ok, observed: { permission: p } };
      }
      case "github-not-team-member": {
        const present = final.github.teamMembers.some((m) => m.slug === a.slug && m.login === a.login);
        return { assertion: a, pass: !present, observed: { present } };
      }
      case "github-not-org-member": {
        const present = final.github.orgMembers.some((m) => m.login === a.login);
        return { assertion: a, pass: !present, observed: { present } };
      }
      case "drive-owner": {
        const f = final.drive.files.find((x) => x.id === a.fileId);
        return { assertion: a, pass: f?.ownerEmail === a.email, observed: { ownerEmail: f?.ownerEmail ?? null } };
      }
      case "drive-no-access": {
        const perms = final.drive.permissions.filter((p) => p.fileId === a.fileId);
        const viaUser = perms.some((p) => p.emailAddress === a.email);
        // Link sharing grants access to everyone, including the person just removed.
        const viaLink = perms.some((p) => p.type === "anyone");
        return { assertion: a, pass: !viaUser && !viaLink, observed: { viaUser, viaLink } };
      }
      case "linear-issue-assignee": {
        const i = final.linear.issues.find((x) => x.id === a.issueId);
        return { assertion: a, pass: (i?.assigneeId ?? null) === a.assigneeId, observed: { assigneeId: i?.assigneeId ?? null } };
      }
      case "linear-not-team-member": {
        const present = final.linear.memberships.some((m) => m.teamId === a.teamId && m.userId === a.userId);
        return { assertion: a, pass: !present, observed: { present } };
      }
      case "slack-message-contains": {
        const hit = final.slack.messages.some((m) => m.channel === a.channel && m.text.includes(a.text));
        return { assertion: a, pass: hit, observed: { messages: final.slack.messages.length } };
      }
      case "world-unchanged": {
        const same = JSON.stringify(stripVolatile(final)) === JSON.stringify(stripVolatile(initial));
        return { assertion: a, pass: same, observed: { same } };
      }
    }
  });
}

/** Slack posts are the one write a rollback is not expected to erase from history. */
function stripVolatile(w: WorldState) {
  return { ...w, slack: { messages: [] } };
}
