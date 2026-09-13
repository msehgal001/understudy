/**
 * WorldState is the single serializable snapshot of all four apps.
 *
 * It is used in three places, deliberately:
 *   1. ShadowAdapter reads and mutates it to simulate writes.
 *   2. Eval scenario fixtures ARE WorldState objects, frozen to disk.
 *   3. The eval oracle inspects the *final* WorldState to compute ground truth.
 *
 * Note (3): the oracle resolves effective access with its own implementation in
 * src/eval/oracle.ts. That duplicates the resolution logic in the shadow GitHub
 * adapter on purpose. If both used one code path, a bug in that path would make
 * the agent's checks and the ground truth agree with each other while both were
 * wrong, and the silent-failure number would be decorative. Two independent
 * implementations of the same documented rule is the point.
 */

export type App = "github" | "drive" | "linear" | "slack";

export type GithubPermission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

/** How a principal actually holds access. Discovery records this, not just a boolean. */
export type GrantPath =
  | { kind: "direct" }
  | { kind: "team"; slug: string }
  | { kind: "org-base" }
  | { kind: "link-sharing"; scope: "anyone" | "domain" }
  | { kind: "group"; groupEmail: string };

export function describeGrantPath(p: GrantPath): string {
  switch (p.kind) {
    case "direct":
      return "direct";
    case "team":
      return `team:${p.slug}`;
    case "org-base":
      return "org-base";
    case "link-sharing":
      return `link-sharing:${p.scope}`;
    case "group":
      return `group:${p.groupEmail}`;
  }
}

export type Grant = {
  app: App;
  resourceId: string;
  resourceName: string;
  permission: string;
  path: GrantPath;
};

// ---------------------------------------------------------------- github

export type GithubWorld = {
  org: string;
  /** Org-wide default. A `write` here grants repo access with no membership record. */
  defaultRepoPermission: GithubPermission;
  repos: { name: string; archived: boolean }[];
  orgMembers: { login: string; role: "member" | "admin"; state: "active" | "pending" }[];
  teams: { slug: string; id: number; name: string }[];
  teamRepos: { slug: string; repo: string; permission: GithubPermission }[];
  teamMembers: { slug: string; login: string; role: "member" | "maintainer" }[];
  directCollaborators: { repo: string; login: string; permission: GithubPermission }[];
};

// ---------------------------------------------------------------- drive

export type DrivePermission = {
  id: string;
  fileId: string;
  /** `anyone` is link sharing: an ACL record wholly independent of any user record. */
  type: "user" | "group" | "domain" | "anyone";
  role: "owner" | "writer" | "commenter" | "reader";
  emailAddress?: string;
  domain?: string;
};

export type DriveWorld = {
  files: { id: string; name: string; ownerEmail: string; trashed: boolean }[];
  permissions: DrivePermission[];
};

// ---------------------------------------------------------------- linear

export type LinearWorld = {
  users: { id: string; email: string; name: string; active: boolean }[];
  teams: { id: string; key: string; name: string }[];
  memberships: { id: string; teamId: string; userId: string }[];
  issues: { id: string; identifier: string; title: string; teamId: string; assigneeId: string | null; state: string }[];
};

// ---------------------------------------------------------------- slack

export type SlackWorld = {
  messages: { channel: string; ts: string; text: string }[];
};

export type WorldState = {
  github: GithubWorld;
  drive: DriveWorld;
  linear: LinearWorld;
  slack: SlackWorld;
};

export function cloneWorld(w: WorldState): WorldState {
  return structuredClone(w);
}

export function emptyWorld(org = "example-org"): WorldState {
  return {
    github: {
      org,
      defaultRepoPermission: "none",
      repos: [],
      orgMembers: [],
      teams: [],
      teamRepos: [],
      teamMembers: [],
      directCollaborators: [],
    },
    drive: { files: [], permissions: [] },
    linear: { users: [], teams: [], memberships: [], issues: [] },
    slack: { messages: [] },
  };
}
