import type { GithubAdapter, WriteResult } from "@/adapters/types";
import type { GithubPermission } from "@/core/world";
import { httpJson } from "@/adapters/http";

const API = "https://api.github.com";

export class LiveGithubAdapter implements GithubAdapter {
  readonly mode = "live" as const;
  constructor(private token: string) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private async get(path: string) {
    return httpJson(`${API}${path}`, { headers: this.headers() });
  }
  private async write(method: string, path: string, body?: unknown): Promise<WriteResult> {
    const res = await httpJson(`${API}${path}`, {
      method,
      headers: { ...this.headers(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: res.body };
  }

  async listOrgRepos(org: string) {
    const res = await this.get(`/orgs/${org}/repos?per_page=100`);
    const rows = asArray<{ name: string; archived: boolean }>(res.body);
    return rows.map((r) => ({ name: r.name, archived: !!r.archived }));
  }

  /** affiliation=direct is what separates a real collaborator record from an inherited one. */
  async listDirectCollaborators(org: string, repo: string) {
    const res = await this.get(`/repos/${org}/${repo}/collaborators?affiliation=direct&per_page=100`);
    const rows = asArray<{ login: string; role_name?: string; permissions?: Record<string, boolean> }>(res.body);
    return rows.map((r) => ({ login: r.login, permission: (r.role_name ?? highestFromFlags(r.permissions)) as GithubPermission }));
  }

  async listRepoTeams(org: string, repo: string) {
    const res = await this.get(`/repos/${org}/${repo}/teams?per_page=100`);
    const rows = asArray<{ slug: string; permission: string; permissions?: Record<string, boolean> }>(res.body);
    return rows.map((t) => ({ slug: t.slug, permission: (t.permission ?? highestFromFlags(t.permissions)) as GithubPermission }));
  }

  async listTeamMembers(org: string, slug: string) {
    const res = await this.get(`/orgs/${org}/teams/${slug}/members?per_page=100`);
    const rows = asArray<{ login: string }>(res.body);
    return rows.map((m) => ({ login: m.login, role: "member" }));
  }

  async getOrgDefaultRepoPermission(org: string) {
    const res = await this.get(`/orgs/${org}`);
    const perm = (res.body as { default_repository_permission?: string })?.default_repository_permission;
    return (perm ?? "none") as GithubPermission;
  }

  async getOrgMembership(org: string, login: string) {
    const res = await this.get(`/orgs/${org}/memberships/${login}`);
    if (res.status === 404) return { state: "none" as const, role: "none" };
    const b = res.body as { state: "active" | "pending"; role: string };
    return { state: b.state, role: b.role };
  }

  async getEffectivePermission(org: string, repo: string, login: string) {
    const res = await this.get(`/repos/${org}/${repo}/collaborators/${login}/permission`);
    if (res.status === 404) return { permission: "none" as GithubPermission };
    const b = res.body as { permission?: string; role_name?: string };
    return { permission: ((b.role_name ?? b.permission ?? "none") as GithubPermission) };
  }

  removeCollaborator(org: string, repo: string, login: string) {
    return this.write("DELETE", `/repos/${org}/${repo}/collaborators/${login}`);
  }
  addCollaborator(org: string, repo: string, login: string, permission: GithubPermission) {
    return this.write("PUT", `/repos/${org}/${repo}/collaborators/${login}`, { permission });
  }
  removeTeamMember(org: string, slug: string, login: string) {
    return this.write("DELETE", `/orgs/${org}/teams/${slug}/memberships/${login}`);
  }
  addTeamMember(org: string, slug: string, login: string, role = "member") {
    return this.write("PUT", `/orgs/${org}/teams/${slug}/memberships/${login}`, { role });
  }
  removeOrgMember(org: string, login: string) {
    return this.write("DELETE", `/orgs/${org}/members/${login}`);
  }
}

/**
 * GitHub answers a 404 (missing repo, missing team, no permission to see it) with
 * a JSON object, not an empty array. Treating that as a list throws deep inside
 * discovery, where the stack trace says nothing useful about the real cause.
 */
function asArray<T>(body: unknown): T[] {
  return Array.isArray(body) ? (body as T[]) : [];
}

function highestFromFlags(p?: Record<string, boolean>): string {
  if (!p) return "none";
  if (p.admin) return "admin";
  if (p.maintain) return "maintain";
  if (p.push) return "write";
  if (p.triage) return "triage";
  if (p.pull) return "read";
  return "none";
}
