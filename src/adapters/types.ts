import type { DrivePermission, GithubPermission } from "@/core/world";

export type AdapterMode = "live" | "shadow";

/**
 * The literal envelope an API returned. Kept deliberately raw — status code plus
 * body — so a shadow write is indistinguishable from a live one at the call site.
 *
 * Nothing in src/checks/ ever receives one of these. See postconditions.ts.
 */
export type WriteResult = {
  status: number;
  body: unknown;
};

export interface GithubAdapter {
  readonly mode: AdapterMode;

  // --- enumeration: these compose the grant path ---
  listOrgRepos(org: string): Promise<{ name: string; archived: boolean }[]>;
  listDirectCollaborators(org: string, repo: string): Promise<{ login: string; permission: GithubPermission }[]>;
  listRepoTeams(org: string, repo: string): Promise<{ slug: string; permission: GithubPermission }[]>;
  listTeamMembers(org: string, slug: string): Promise<{ login: string; role: string }[]>;
  getOrgDefaultRepoPermission(org: string): Promise<GithubPermission>;
  getOrgMembership(org: string, login: string): Promise<{ state: "active" | "pending" | "none"; role: string }>;

  /**
   * The oracle, not the discoverer. GitHub documents that this returns the highest
   * role calculated across repository, team, organization and enterprise, and that
   * there is presently no way to tell which of those produced it. So it can answer
   * "does effective access survive?" and cannot answer "why?". Discovery composes
   * the why from the three enumeration calls above.
   */
  getEffectivePermission(org: string, repo: string, login: string): Promise<{ permission: GithubPermission }>;

  // --- writes ---
  removeCollaborator(org: string, repo: string, login: string): Promise<WriteResult>;
  addCollaborator(org: string, repo: string, login: string, permission: GithubPermission): Promise<WriteResult>;
  removeTeamMember(org: string, slug: string, login: string): Promise<WriteResult>;
  addTeamMember(org: string, slug: string, login: string, role?: string): Promise<WriteResult>;
  removeOrgMember(org: string, login: string): Promise<WriteResult>;
}

export interface DriveAdapter {
  readonly mode: AdapterMode;

  listFilesSharedWith(email: string): Promise<{ id: string; name: string; ownerEmail: string; trashed: boolean }[]>;
  listPermissions(fileId: string): Promise<DrivePermission[]>;
  getFile(fileId: string): Promise<{ id: string; name: string; ownerEmail: string; trashed: boolean } | null>;

  deletePermission(fileId: string, permissionId: string): Promise<WriteResult>;
  createPermission(
    fileId: string,
    p: { type: DrivePermission["type"]; role: DrivePermission["role"]; emailAddress?: string },
  ): Promise<WriteResult>;
  transferOwnership(fileId: string, newOwnerEmail: string): Promise<WriteResult>;
}

export interface LinearAdapter {
  readonly mode: AdapterMode;

  getUserByEmail(email: string): Promise<{ id: string; email: string; name: string; active: boolean } | null>;
  listAssignedIssues(userId: string): Promise<{ id: string; identifier: string; title: string; teamId: string; assigneeId: string | null; state: string }[]>;
  listTeamMemberships(userId: string): Promise<{ id: string; teamId: string; userId: string }[]>;
  getIssue(issueId: string): Promise<{ id: string; identifier: string; assigneeId: string | null; state: string } | null>;
  getTeam(teamId: string): Promise<{ id: string; key: string; name: string } | null>;

  reassignIssue(issueId: string, assigneeId: string | null): Promise<WriteResult>;
  removeTeamMembership(membershipId: string): Promise<WriteResult>;
  addTeamMembership(teamId: string, userId: string): Promise<WriteResult>;
  createIssue(input: { teamId: string; title: string; description: string }): Promise<WriteResult>;
  /** Inverse of createIssue. Linear has no hard delete; archive is the real undo. */
  archiveIssue(issueId: string): Promise<WriteResult>;
}

export interface SlackAdapter {
  readonly mode: AdapterMode;
  postMessage(channel: string, text: string): Promise<WriteResult>;
  listMessages(channel: string): Promise<{ ts: string; text: string }[]>;
  deleteMessage(channel: string, ts: string): Promise<WriteResult>;
}

export type AdapterSet = {
  mode: AdapterMode;
  github: GithubAdapter;
  drive: DriveAdapter;
  linear: LinearAdapter;
  slack: SlackAdapter;
};
