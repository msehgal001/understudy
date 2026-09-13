import type { GithubAdapter, WriteResult } from "@/adapters/types";
import type { GithubPermission, WorldState } from "@/core/world";
import { cloneWorld } from "@/core/world";
import { FaultInjector, type Fault } from "@/adapters/faults";

const RANK: Record<GithubPermission, number> = {
  none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5,
};

/**
 * Shadow GitHub.
 *
 * The whole value of this class is that it models GRANT PATHS, not booleans.
 * removeCollaborator deletes only the direct-collaborator record and returns a
 * bare 204, exactly as the real API does — a team-derived or org-base grant is
 * left standing and the caller gets no hint. If shadow simply flipped an
 * "hasAccess" flag, rehearsal would print a clean diff that live then
 * contradicts, and the rehearsal phase would be worse than useless.
 */
export class ShadowGithubAdapter implements GithubAdapter {
  readonly mode = "shadow" as const;
  private faults: FaultInjector;
  /** Pre-write snapshot, served when a `stale` fault fires. */
  private stale: WorldState;

  constructor(private world: WorldState, faults: Fault[] = []) {
    this.faults = new FaultInjector(faults);
    this.stale = cloneWorld(world);
  }

  private read(op: string): WorldState {
    return this.faults.check(op) === "stale" ? this.stale : this.world;
  }

  private beforeWrite(op: string) {
    this.faults.check(op);
    this.stale = cloneWorld(this.world);
  }

  async listOrgRepos(_org: string) {
    return this.read("github.listOrgRepos").github.repos.map((r) => ({ ...r }));
  }

  async listDirectCollaborators(_org: string, repo: string) {
    return this.read("github.listDirectCollaborators")
      .github.directCollaborators.filter((c) => c.repo === repo)
      .map((c) => ({ login: c.login, permission: c.permission }));
  }

  async listRepoTeams(_org: string, repo: string) {
    return this.read("github.listRepoTeams")
      .github.teamRepos.filter((t) => t.repo === repo)
      .map((t) => ({ slug: t.slug, permission: t.permission }));
  }

  async listTeamMembers(_org: string, slug: string) {
    return this.read("github.listTeamMembers")
      .github.teamMembers.filter((m) => m.slug === slug)
      .map((m) => ({ login: m.login, role: m.role }));
  }

  async getOrgDefaultRepoPermission(_org: string) {
    return this.read("github.getOrgDefaultRepoPermission").github.defaultRepoPermission;
  }

  async getOrgMembership(_org: string, login: string) {
    const m = this.read("github.getOrgMembership").github.orgMembers.find((o) => o.login === login);
    return m ? { state: m.state, role: m.role } : { state: "none" as const, role: "none" };
  }

  /**
   * Highest role across direct, team and org-base — GitHub's documented resolution.
   * Independently re-implemented in src/eval/oracle.ts; see the note in core/world.ts.
   */
  async getEffectivePermission(_org: string, repo: string, login: string) {
    const w = this.read("github.getEffectivePermission").github;
    const member = w.orgMembers.find((o) => o.login === login && o.state === "active");

    let best: GithubPermission = "none";
    const raise = (p: GithubPermission) => {
      if (RANK[p] > RANK[best]) best = p;
    };

    for (const c of w.directCollaborators) if (c.repo === repo && c.login === login) raise(c.permission);

    if (member) {
      for (const tm of w.teamMembers.filter((m) => m.login === login)) {
        for (const tr of w.teamRepos) if (tr.slug === tm.slug && tr.repo === repo) raise(tr.permission);
      }
      raise(w.defaultRepoPermission);
    }
    return { permission: best };
  }

  // ------------------------------------------------------------ writes

  /** Real behaviour: 204 No Content, empty body, direct grant only. */
  async removeCollaborator(_org: string, repo: string, login: string): Promise<WriteResult> {
    this.beforeWrite("github.removeCollaborator");
    this.world.github.directCollaborators = this.world.github.directCollaborators.filter(
      (c) => !(c.repo === repo && c.login === login),
    );
    return { status: 204, body: null };
  }

  async addCollaborator(_org: string, repo: string, login: string, permission: GithubPermission): Promise<WriteResult> {
    this.beforeWrite("github.addCollaborator");
    const existing = this.world.github.directCollaborators.find((c) => c.repo === repo && c.login === login);
    if (existing) existing.permission = permission;
    else this.world.github.directCollaborators.push({ repo, login, permission });
    return { status: 201, body: { permissions: permission } };
  }

  async removeTeamMember(_org: string, slug: string, login: string): Promise<WriteResult> {
    this.beforeWrite("github.removeTeamMember");
    this.world.github.teamMembers = this.world.github.teamMembers.filter(
      (m) => !(m.slug === slug && m.login === login),
    );
    return { status: 204, body: null };
  }

  async addTeamMember(_org: string, slug: string, login: string, role = "member"): Promise<WriteResult> {
    this.beforeWrite("github.addTeamMember");
    if (!this.world.github.teamMembers.some((m) => m.slug === slug && m.login === login)) {
      this.world.github.teamMembers.push({ slug, login, role: role as "member" | "maintainer" });
    }
    return { status: 200, body: { state: "active", role } };
  }

  /** Real behaviour: org removal DOES cascade to team memberships. */
  async removeOrgMember(_org: string, login: string): Promise<WriteResult> {
    this.beforeWrite("github.removeOrgMember");
    this.world.github.orgMembers = this.world.github.orgMembers.filter((o) => o.login !== login);
    this.world.github.teamMembers = this.world.github.teamMembers.filter((m) => m.login !== login);
    return { status: 204, body: null };
  }
}
