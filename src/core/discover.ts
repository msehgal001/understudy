import type { AdapterSet } from "@/adapters/types";
import type { OffboardTarget } from "@/core/config";
import type { Grant, GrantPath } from "@/core/world";
import type { Tracer } from "@/core/trace";

export type DriveFinding = {
  id: string;
  name: string;
  ownerEmail: string;
  departingIsOwner: boolean;
  /** No other user permission carries a role that could take over. Transfer is mandatory. */
  soleOwner: boolean;
  permissions: { id: string; type: string; role: string; emailAddress?: string }[];
  linkSharing: boolean;
};

export type Discovery = {
  target: OffboardTarget;
  org: string;
  github: {
    orgMembership: { state: string; role: string };
    grants: Grant[];
    teams: string[];
  };
  drive: { files: DriveFinding[] };
  linear: {
    userId: string | null;
    /** Resolved so the planner can reassign to a real person instead of guessing an id. */
    successorUserId: string | null;
    issues: { id: string; identifier: string; title: string; teamId: string; state: string }[];
    memberships: { id: string; teamId: string }[];
  };
};

/**
 * Read-only enumeration. Records the grant PATH, not just the grant.
 *
 * GitHub's permission endpoint returns the highest role across repository, team,
 * organization and enterprise and documents no way to tell which produced it. So
 * the path is composed here from three independent enumerations — direct
 * collaborators, repo teams crossed with team membership, and the org default
 * repository permission. The permission endpoint is deliberately not used in this
 * phase: it is the oracle used in verify, and asking it "why" would get a wrong
 * answer confidently.
 */
export async function discover(adapters: AdapterSet, target: OffboardTarget, org: string, tracer: Tracer): Promise<Discovery> {
  tracer.emit({ type: "phase", phase: "discover", label: "discover:start", detail: { org, login: target.githubLogin } });

  const gh = adapters.github;
  const grants: Grant[] = [];

  const membership = await tracer.span(
    { type: "tool", phase: "discover", label: "github.getOrgMembership" },
    () => gh.getOrgMembership(org, target.githubLogin),
  );

  const repos = await tracer.span({ type: "tool", phase: "discover", label: "github.listOrgRepos" }, () =>
    gh.listOrgRepos(org),
  );

  const basePermission = await tracer.span(
    { type: "tool", phase: "discover", label: "github.getOrgDefaultRepoPermission" },
    () => gh.getOrgDefaultRepoPermission(org),
  );

  const teamsWithUser = new Set<string>();

  for (const repo of repos) {
    const direct = await gh.listDirectCollaborators(org, repo.name);
    for (const c of direct) {
      if (c.login !== target.githubLogin) continue;
      grants.push(push(org, repo.name, c.permission, { kind: "direct" }));
    }

    if (membership.state === "active") {
      const repoTeams = await gh.listRepoTeams(org, repo.name);
      for (const t of repoTeams) {
        const members = await gh.listTeamMembers(org, t.slug);
        if (!members.some((m) => m.login === target.githubLogin)) continue;
        teamsWithUser.add(t.slug);
        grants.push(push(org, repo.name, t.permission, { kind: "team", slug: t.slug }));
      }
      if (basePermission !== "none") {
        grants.push(push(org, repo.name, basePermission, { kind: "org-base" }));
      }
    }
  }

  // Teams reached above came from repositories. A team with no repository grants
  // has no repo-team record anywhere, so it is invisible to that walk while still
  // being a real membership. Enumerate the org's teams directly and close the gap.
  if (membership.state === "active") {
    const orgTeams = await tracer.span({ type: "tool", phase: "discover", label: "github.listOrgTeams" }, () =>
      gh.listOrgTeams(org),
    );
    for (const t of orgTeams) {
      if (teamsWithUser.has(t.slug)) continue;
      const members = await gh.listTeamMembers(org, t.slug);
      if (members.some((m) => m.login === target.githubLogin)) teamsWithUser.add(t.slug);
    }
  }

  tracer.emit({
    type: "note", phase: "discover", label: "github.grants",
    detail: { count: grants.length, paths: grants.map((g) => g.path.kind) },
  });

  // ------------------------------------------------------------ drive
  const files: DriveFinding[] = [];
  try {
    const shared = await tracer.span({ type: "tool", phase: "discover", label: "drive.listFilesSharedWith" }, () =>
      adapters.drive.listFilesSharedWith(target.email),
    );
    for (const f of shared) {
      const perms = await adapters.drive.listPermissions(f.id);
      const others = perms.filter((p) => p.type === "user" && p.emailAddress !== target.email);
      files.push({
        id: f.id, name: f.name, ownerEmail: f.ownerEmail,
        departingIsOwner: f.ownerEmail === target.email,
        soleOwner: f.ownerEmail === target.email && others.length === 0,
        permissions: perms.map((p) => ({ id: p.id, type: p.type, role: p.role, emailAddress: p.emailAddress })),
        linkSharing: perms.some((p) => p.type === "anyone"),
      });
    }
  } catch (err) {
    tracer.emit({ type: "note", phase: "discover", label: "drive.unavailable", ok: false, detail: String(err) });
  }

  // ------------------------------------------------------------ linear
  let linear: Discovery["linear"] = { userId: null, successorUserId: null, issues: [], memberships: [] };
  try {
    const user = await tracer.span({ type: "tool", phase: "discover", label: "linear.getUserByEmail" }, () =>
      adapters.linear.getUserByEmail(target.email),
    );
    if (user) {
      const issues = await adapters.linear.listAssignedIssues(user.id);
      const memberships = await adapters.linear.listTeamMemberships(user.id);
      const successor = target.successorEmail ? await adapters.linear.getUserByEmail(target.successorEmail) : null;
      linear = {
        userId: user.id,
        successorUserId: successor && successor.active ? successor.id : null,
        issues: issues.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, teamId: i.teamId, state: i.state })),
        memberships: memberships.map((m) => ({ id: m.id, teamId: m.teamId })),
      };
    }
  } catch (err) {
    tracer.emit({ type: "note", phase: "discover", label: "linear.unavailable", ok: false, detail: String(err) });
  }

  const d: Discovery = {
    target, org,
    github: { orgMembership: membership, grants, teams: [...teamsWithUser] },
    drive: { files },
    linear,
  };

  tracer.emit({
    type: "phase", phase: "discover", label: "discover:done",
    detail: { githubGrants: grants.length, driveFiles: files.length, linearIssues: linear.issues.length },
  });
  return d;
}

function push(org: string, repo: string, permission: string, path: GrantPath): Grant {
  return { app: "github", resourceId: `${org}/${repo}`, resourceName: `${org}/${repo}`, permission, path };
}
