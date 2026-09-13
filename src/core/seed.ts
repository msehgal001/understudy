import type { AdapterSet } from "@/adapters/types";
import type { OffboardTarget } from "@/core/config";
import { emptyWorld, type WorldState } from "@/core/world";
import type { Tracer } from "@/core/trace";

/**
 * Build a shadow WorldState from real live reads at run start.
 *
 * Rehearsal is only worth anything if the world it rehearses against is the world
 * that commit will meet. Seeding from a snapshot taken seconds earlier is the
 * closest achievable version of that, and the precondition checks at commit time
 * catch whatever drifted in between.
 */
export async function seedWorldFromLive(
  live: AdapterSet,
  target: OffboardTarget,
  org: string,
  tracer: Tracer,
): Promise<WorldState> {
  const w = emptyWorld(org);
  tracer.emit({ type: "phase", phase: "rehearse", label: "shadow:seed-start", detail: { org } });

  w.github.defaultRepoPermission = await live.github.getOrgDefaultRepoPermission(org);
  w.github.repos = await live.github.listOrgRepos(org);

  const membership = await live.github.getOrgMembership(org, target.githubLogin);
  if (membership.state !== "none") {
    w.github.orgMembers.push({
      login: target.githubLogin,
      role: membership.role === "admin" ? "admin" : "member",
      state: membership.state,
    });
  }

  const seenTeams = new Set<string>();
  for (const repo of w.github.repos) {
    for (const c of await live.github.listDirectCollaborators(org, repo.name)) {
      w.github.directCollaborators.push({ repo: repo.name, login: c.login, permission: c.permission });
    }
    for (const t of await live.github.listRepoTeams(org, repo.name)) {
      w.github.teamRepos.push({ slug: t.slug, repo: repo.name, permission: t.permission });
      if (seenTeams.has(t.slug)) continue;
      seenTeams.add(t.slug);
      w.github.teams.push({ slug: t.slug, id: w.github.teams.length + 1, name: t.slug });
      for (const m of await live.github.listTeamMembers(org, t.slug)) {
        w.github.teamMembers.push({ slug: t.slug, login: m.login, role: "member" });
      }
    }
  }

  try {
    for (const f of await live.drive.listFilesSharedWith(target.email)) {
      w.drive.files.push(f);
      w.drive.permissions.push(...(await live.drive.listPermissions(f.id)));
    }
  } catch (err) {
    tracer.emit({ type: "note", phase: "rehearse", label: "drive.seed-skipped", ok: false, detail: String(err) });
  }

  try {
    const user = await live.linear.getUserByEmail(target.email);
    if (user) {
      w.linear.users.push(user);
      for (const i of await live.linear.listAssignedIssues(user.id)) w.linear.issues.push(i);
      for (const m of await live.linear.listTeamMemberships(user.id)) w.linear.memberships.push(m);
      const teamIds = new Set(w.linear.memberships.map((m) => m.teamId).concat(w.linear.issues.map((i) => i.teamId)));
      for (const id of teamIds) if (id) w.linear.teams.push({ id, key: id.slice(0, 4).toUpperCase(), name: id });
    }
  } catch (err) {
    tracer.emit({ type: "note", phase: "rehearse", label: "linear.seed-skipped", ok: false, detail: String(err) });
  }

  tracer.emit({
    type: "phase", phase: "rehearse", label: "shadow:seed-done",
    detail: {
      repos: w.github.repos.length, teams: w.github.teams.length,
      collaborators: w.github.directCollaborators.length,
      driveFiles: w.drive.files.length, linearIssues: w.linear.issues.length,
    },
  });
  return w;
}
