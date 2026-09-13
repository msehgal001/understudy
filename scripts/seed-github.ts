/**
 * Provisions the demo GitHub fixture. Idempotent: run it before every demo and it
 * repairs drift rather than assuming a clean slate.
 *
 * The fixture seeds TWO independent silent-failure paths on purpose:
 *
 *   1. team:payments holds ADMIN on the repo, and the departing user is a member.
 *      Removing their direct-collaborator record returns 204 and leaves admin.
 *      A naive plan hits this; a careful plan may pre-empt it.
 *
 *   2. The org's default_repository_permission is `write`, so every member has
 *      write on every repo with NO collaborator and NO team record to delete.
 *      No per-repo action can close this, which makes the catch plan-proof — it
 *      does not depend on the model being careless. The only per-user fix is
 *      removing org membership, which is irreversible and stops for approval.
 *
 * Path 2 is why the demo is reproducible on every run rather than a lucky accident.
 */
import { LiveGithubAdapter } from "@/adapters/github/live";
import { httpJson } from "@/adapters/http";
import { readConfig } from "@/core/config";
import { green, red, amber, dim, bold, mono } from "@/cli/render";

const REPO = process.env.DEMO_REPO ?? "payments-core";
const TEAM = process.env.DEMO_TEAM ?? "payments";

async function main() {
  const c = readConfig();
  if (!c.githubToken || !c.githubOrg || !c.target.githubLogin) {
    console.error(red("need GITHUB_TOKEN, GITHUB_ORG and DEPARTING_GITHUB_LOGIN in .env"));
    process.exit(2);
  }
  const org = c.githubOrg;
  const login = c.target.githubLogin;
  const H = { Authorization: `Bearer ${c.githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const api = (p: string, init: RequestInit = {}) =>
    httpJson(`https://api.github.com${p}`, { ...init, headers: { ...H, ...(init.body ? { "Content-Type": "application/json" } : {}) } });

  const step = (s: string) => console.log(`  ${dim("·")} ${s}`);
  console.log(`\n${bold("SEEDING")} ${mono(`${org}/${REPO}`)} ${dim(`departing=${login}`)}\n`);

  // -- token scope check first: everything below needs org write.
  const scopes = (await api("/user")).headers.get("x-oauth-scopes") ?? "";
  if (!/\badmin:org\b|\bwrite:org\b/.test(scopes)) {
    console.error(red(`token lacks org write. scopes: "${scopes}"`));
    console.error(amber("  fix: gh auth refresh -h github.com -s admin:org,repo"));
    process.exit(2);
  }
  step(`token scopes ok (${scopes})`);

  // -- repo
  let repo = await api(`/repos/${org}/${REPO}`);
  if (repo.status === 404) {
    repo = await api(`/orgs/${org}/repos`, { method: "POST", body: JSON.stringify({ name: REPO, private: true, auto_init: true }) });
    if (repo.status >= 300) { console.error(red(`could not create repo: ${JSON.stringify(repo.body)}`)); process.exit(2); }
    step(`created repo ${REPO}`);
  } else step(`repo ${REPO} exists`);

  // -- team with ADMIN on the repo
  let team = await api(`/orgs/${org}/teams/${TEAM}`);
  if (team.status === 404) {
    team = await api(`/orgs/${org}/teams`, { method: "POST", body: JSON.stringify({ name: TEAM, privacy: "closed" }) });
    if (team.status >= 300) { console.error(red(`could not create team: ${JSON.stringify(team.body)}`)); process.exit(2); }
    step(`created team ${TEAM}`);
  } else step(`team ${TEAM} exists`);

  const grant = await api(`/orgs/${org}/teams/${TEAM}/repos/${org}/${REPO}`, {
    method: "PUT", body: JSON.stringify({ permission: "admin" }),
  });
  if (grant.status >= 300) { console.error(red(`could not grant team admin: ${JSON.stringify(grant.body)}`)); process.exit(2); }
  step(`team ${TEAM} has admin on ${REPO}`);

  // -- org membership must be ACTIVE, not pending
  // Confirm the account exists before inviting it. A PUT to a nonexistent login
  // 404s, and an unchecked write here would report "invitation sent" over nothing
  // — which is the exact failure mode this project exists to catch, in the script
  // that sets up the demonstration of it. Checked now.
  const userCheck = await api(`/users/${login}`);
  if (userCheck.status === 404) {
    console.error(`\n${red(bold("NO SUCH GITHUB USER"))}`);
    console.error(amber(`  DEPARTING_GITHUB_LOGIN is "${login}" and github.com/${login} does not exist.`));
    console.error(amber(`  Check the spelling in .env before inviting anyone.`));
    process.exit(2);
  }

  const membership = await api(`/orgs/${org}/memberships/${login}`);
  if (membership.status === 404) {
    const invite = await api(`/orgs/${org}/memberships/${login}`, { method: "PUT", body: JSON.stringify({ role: "member" }) });
    if (invite.status >= 300) {
      console.error(`\n${red(bold("INVITATION FAILED"))}`);
      console.error(red(`  PUT /orgs/${org}/memberships/${login} returned ${invite.status}: ${JSON.stringify(invite.body)}`));
      process.exit(2);
    }
    console.error(`\n${red(bold("INVITATION SENT — FIXTURE NOT READY"))}`);
    console.error(amber(`  ${login} must accept the emailed invitation to ${org} before the fixture can exist.`));
    console.error(amber(`  A pending member holds no team-derived grant, so there is nothing for verify to catch.`));
    console.error(amber(`  Accept it, then run this script again.`));
    process.exit(3);
  }
  const state = (membership.body as { state: string }).state;
  if (state !== "active") {
    console.error(`\n${red(bold("MEMBERSHIP IS PENDING — FIXTURE NOT READY"))}`);
    console.error(amber(`  ${login}'s membership in ${org} is "${state}". They must accept the invitation.`));
    console.error(amber(`  Until then no team grant exists and the seeded failure cannot reproduce.`));
    process.exit(3);
  }
  step(`${login} is an active org member`);

  // -- team membership (path 1)
  const tm = await api(`/orgs/${org}/teams/${TEAM}/memberships/${login}`, { method: "PUT", body: JSON.stringify({ role: "member" }) });
  if (tm.status >= 300) { console.error(red(`could not add to team: ${JSON.stringify(tm.body)}`)); process.exit(2); }
  step(`${login} is in team ${TEAM}`);

  // -- direct collaborator at a LOWER permission, so the revoke has something to
  //    succeed at while the higher team grant survives it
  await api(`/repos/${org}/${REPO}/collaborators/${login}`, { method: "PUT", body: JSON.stringify({ permission: "push" }) });
  step(`${login} is a direct collaborator (push)`);

  // -- org base permission (path 2: the plan-proof one)
  const orgPatch = await api(`/orgs/${org}`, { method: "PATCH", body: JSON.stringify({ default_repository_permission: "write" }) });
  if (orgPatch.status >= 300) {
    console.log(`  ${amber("!")} could not set default_repository_permission (${orgPatch.status}). Path 2 unavailable; path 1 still seeded.`);
  } else step(`org default_repository_permission = write`);

  // -- assert the trap actually exists
  const gh = new LiveGithubAdapter(c.githubToken);
  const eff = await gh.getEffectivePermission(org, REPO, login);
  console.log("");
  if (eff.permission !== "admin") {
    console.error(red(`FIXTURE ASSERTION FAILED: effective permission is "${eff.permission}", expected "admin".`));
    process.exit(2);
  }
  console.log(`  ${green("✓")} fixture verified: ${mono(login)} has ${bold("admin")} on ${mono(`${org}/${REPO}`)}`);
  console.log(`  ${dim("paths: direct(push) + team:" + TEAM + "(admin) + org-base(write)")}`);
  // Seeding rewinds the world on purpose, which makes any recorded idempotency
  // keys for this person stale. Clearing them keeps repeat demos honest.
  try {
    const { getDb } = await import("@/core/db");
    const removed = getDb().prepare("DELETE FROM idempotency WHERE target = ?").run(login).changes;
    if (removed) console.log(`  ${dim(`cleared ${removed} stale idempotency key(s) for ${login}`)}`);
  } catch {
    /* no database yet — nothing to clear */
  }

  console.log(`\n  ${green("ready.")} ${dim("Removing the collaborator record will return 204 and leave admin standing.")}\n`);
}
main();
