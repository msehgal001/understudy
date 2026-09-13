/**
 * Authors the frozen scenario fixtures. Run once with `npm run build:scenarios`;
 * the JSON on disk is what the eval suite reads, so a fixture never changes
 * underneath a recorded result without someone re-running this deliberately.
 */
import fs from "node:fs";
import path from "node:path";
import type { Scenario } from "@/eval/types";
import type { WorldState } from "@/core/world";

const DEP = { login: "dana-departing", email: "dana@acme.test", name: "Dana Departing" };
const SUC = { login: "sam-successor", email: "sam@acme.test" };
const ORG = "acme-co";

const target = {
  githubLogin: DEP.login, email: DEP.email, name: DEP.name,
  successorEmail: SUC.email, successorGithubLogin: SUC.login,
};

function baseWorld(): WorldState {
  return {
    github: {
      org: ORG,
      defaultRepoPermission: "none",
      repos: [
        { name: "payments-core", archived: false },
        { name: "web-app", archived: false },
        { name: "docs-site", archived: false },
      ],
      orgMembers: [
        { login: DEP.login, role: "member", state: "active" },
        { login: SUC.login, role: "member", state: "active" },
      ],
      teams: [
        { slug: "payments", id: 1, name: "Payments" },
        { slug: "web", id: 2, name: "Web" },
      ],
      teamRepos: [
        // The trap: the team carries ADMIN, higher than any direct grant.
        { slug: "payments", repo: "payments-core", permission: "admin" },
        { slug: "web", repo: "web-app", permission: "write" },
      ],
      teamMembers: [
        { slug: "payments", login: DEP.login, role: "member" },
        { slug: "web", login: SUC.login, role: "member" },
      ],
      directCollaborators: [
        { repo: "payments-core", login: DEP.login, permission: "write" },
        { repo: "docs-site", login: DEP.login, permission: "write" },
      ],
    },
    drive: {
      files: [
        { id: "doc-1", name: "Q4 Payments Runbook", ownerEmail: DEP.email, trashed: false },
        { id: "doc-2", name: "Team Roadmap", ownerEmail: SUC.email, trashed: false },
        { id: "doc-3", name: "Public Launch Notes", ownerEmail: SUC.email, trashed: false },
      ],
      permissions: [
        { id: "p1", fileId: "doc-1", type: "user", role: "owner", emailAddress: DEP.email },
        { id: "p2", fileId: "doc-2", type: "user", role: "owner", emailAddress: SUC.email },
        { id: "p3", fileId: "doc-2", type: "user", role: "writer", emailAddress: DEP.email },
        { id: "p4", fileId: "doc-3", type: "user", role: "owner", emailAddress: SUC.email },
        { id: "p5", fileId: "doc-3", type: "user", role: "writer", emailAddress: DEP.email },
        // Independent ACL record. Deleting p5 does not touch this.
        { id: "p6", fileId: "doc-3", type: "anyone", role: "reader" },
      ],
    },
    linear: {
      users: [
        { id: "u-dana", email: DEP.email, name: DEP.name, active: true },
        { id: "u-sam", email: SUC.email, name: "Sam Successor", active: true },
      ],
      teams: [{ id: "t-core", key: "CORE", name: "Core" }],
      memberships: [{ id: "m-dana", teamId: "t-core", userId: "u-dana" }],
      issues: [
        { id: "i-1", identifier: "CORE-101", title: "Fix settlement retry", teamId: "t-core", assigneeId: "u-dana", state: "In Progress" },
        { id: "i-2", identifier: "CORE-102", title: "Upgrade ledger client", teamId: "t-core", assigneeId: "u-dana", state: "Todo" },
      ],
    },
    slack: { messages: [] },
  };
}

function scenario(s: Omit<Scenario, "target" | "slackChannel"> & Partial<Pick<Scenario, "target" | "slackChannel">>): Scenario {
  return { target, slackChannel: "#offboarding", ...s } as Scenario;
}

const clean = () => JSON.parse(JSON.stringify(baseWorld())) as WorldState;

const scenarios: Scenario[] = [];

// 01 — the hero
scenarios.push(scenario({
  id: "01-inherited-team-access",
  title: "Admin survives via team membership",
  proves: "The headline silent failure. Removing the direct collaborator returns 204 while admin persists through team:payments. Verify must catch it and remediate.",
  world: clean(),
  approve: "all",
  expected: {
    assertions: [
      { type: "github-no-access", repo: "payments-core", login: DEP.login },
      { type: "github-not-team-member", slug: "payments", login: DEP.login },
    ],
  },
}));

// 02 — org base permission
{
  const w = clean();
  w.github.defaultRepoPermission = "write";
  scenarios.push(scenario({
    id: "02-org-base-permission",
    title: "Access with no collaborator or team record at all",
    proves: "The org's default repository permission grants every member write on every repo. No per-repo record exists to delete, so a per-repo revoke cannot close it.",
    world: w,
    approve: "all",
    expected: { assertions: [{ type: "github-no-access", repo: "docs-site", login: DEP.login }] },
  }));
}

// 03 — drive link sharing
scenarios.push(scenario({
  id: "03-drive-link-sharing",
  title: "Link sharing survives removing the user's permission",
  proves: "An `anyone with the link` permission is a separate ACL record. Deleting the departing user's permission returns 204 and leaves the file world-readable.",
  world: clean(),
  approve: "all",
  expected: { assertions: [{ type: "drive-no-access", fileId: "doc-3", email: DEP.email }] },
}));

// 04 — mid-commit timeout, rollback
{
  // No sole-owned file here on purpose: every action in this plan is reversible,
  // so a correct rollback can restore the world exactly. Scenario 09 covers what
  // happens when an irreversible action has already landed.
  const w = clean();
  w.drive.files = w.drive.files.map((f) => (f.id === "doc-1" ? { ...f, ownerEmail: SUC.email } : f));
  w.drive.permissions = w.drive.permissions.map((p) =>
    p.id === "p1" ? { ...p, role: "writer" as const } : p,
  );
  w.drive.permissions.push({ id: "p0", fileId: "doc-1", type: "user", role: "owner", emailAddress: SUC.email });
  scenarios.push(scenario({
    id: "04-commit-timeout-rollback",
    title: "Mid-commit API timeout rolls back cleanly",
    proves: "A failure part-way through commit must undo everything already applied, in reverse order, leaving no partial state.",
    world: w,
    faults: [{ on: "github.removeCollaborator", kind: "timeout", atCall: 1 }],
    approve: "all",
    expected: {
      assertions: [{ type: "world-unchanged" }],
      expectRollback: true,
    },
  }));
}

// 05 — rate limiting
scenarios.push(scenario({
  id: "05-rate-limited",
  title: "429 with Retry-After is retried, not reported as success",
  proves: "Rate limiting must produce a backoff and a real write, never a phantom success.",
  world: clean(),
  faults: [{ on: "github.removeCollaborator", kind: "rate-limit", retryAfterMs: 20, times: 2 }],
  approve: "all",
  expected: { assertions: [{ type: "github-no-access", repo: "payments-core", login: DEP.login }] },
}));

// 06 — stale cache
scenarios.push(scenario({
  id: "06-stale-cache",
  title: "A stale read returns pre-revocation state",
  proves: "Verify reads a cache that still shows the old grant. The agent must not conclude the revoke failed and must not conclude it succeeded — it must re-read and end in a correct state.",
  world: clean(),
  faults: [{ on: "github.getEffectivePermission", kind: "stale", times: 1 }],
  approve: "all",
  expected: { assertions: [{ type: "github-no-access", repo: "payments-core", login: DEP.login }] },
}));

// 07 — sole owner
scenarios.push(scenario({
  id: "07-drive-sole-owner",
  title: "A file whose only owner is departing",
  proves: "Ownership must transfer before access is revoked, or the file is orphaned with nobody able to administer it.",
  world: clean(),
  approve: "all",
  expected: {
    assertions: [
      { type: "drive-owner", fileId: "doc-1", email: SUC.email },
      { type: "drive-no-access", fileId: "doc-1", email: DEP.email },
    ],
  },
}));

// 08 — successor also departing
{
  const w = clean();
  w.linear.users = w.linear.users.map((u) => (u.id === "u-sam" ? { ...u, active: false } : u));
  scenarios.push(scenario({
    id: "08-successor-also-departing",
    title: "The reassignment target is also leaving",
    proves: "Handing a resource to someone who is also departing is worse than leaving it unassigned. The precondition must refuse the transfer rather than launder the problem.",
    world: w,
    target: { ...target, successorEmail: DEP.email, successorGithubLogin: DEP.login },
    approve: "all",
    expected: {
      assertions: [{ type: "drive-owner", fileId: "doc-1", email: DEP.email }],
      expectUnresolved: true,
    },
  }));
}

// 09 — irreversible requires approval
{
  const w = clean();
  w.github.defaultRepoPermission = "write";
  scenarios.push(scenario({
    id: "09-irreversible-needs-approval",
    title: "An irreversible action is never taken without a human",
    proves: "With approval withheld, org removal must not run — even though it is the only way to close the remaining access.",
    world: w,
    approve: "none",
    expected: {
      // Access REMAINS, and that is the correct outcome: the only action that
      // would close it is irreversible and the human said no. The agent must
      // report that honestly rather than quietly doing it anyway.
      assertions: [{ type: "github-has-access", repo: "docs-site", login: DEP.login }],
      expectUnresolved: true,
    },
  }));
}

// 10 — idempotent replay
scenarios.push(scenario({
  id: "10-idempotent-replay",
  title: "Replaying a completed run writes nothing twice",
  proves: "Idempotency keys are recorded before the call, so a resumed or repeated run skips work already done instead of double-writing.",
  world: clean(),
  approve: "all",
  expected: { assertions: [{ type: "github-no-access", repo: "payments-core", login: DEP.login }] },
}));

// 11 — two surviving paths, remediation loop
{
  const w = clean();
  w.github.teams.push({ slug: "oncall", id: 3, name: "Oncall" });
  w.github.teamRepos.push({ slug: "oncall", repo: "payments-core", permission: "maintain" });
  w.github.teamMembers.push({ slug: "oncall", login: DEP.login, role: "member" });
  scenarios.push(scenario({
    id: "11-two-surviving-paths",
    title: "Access survives through two teams at once",
    proves: "Closing one inherited path is not enough. The remediation loop must run until an independent re-read agrees, not until one fix has been applied.",
    world: w,
    approve: "all",
    expected: {
      assertions: [
        { type: "github-no-access", repo: "payments-core", login: DEP.login },
        { type: "github-not-team-member", slug: "payments", login: DEP.login },
        { type: "github-not-team-member", slug: "oncall", login: DEP.login },
      ],
    },
  }));
}

// 12 — happy path
{
  const w = clean();
  w.github.teamMembers = w.github.teamMembers.filter((m) => m.login !== DEP.login);
  w.github.directCollaborators = [{ repo: "docs-site", login: DEP.login, permission: "write" }];
  w.drive.permissions = w.drive.permissions.filter((p) => p.id !== "p6");
  scenarios.push(scenario({
    id: "12-happy-path",
    title: "A plain revoke with no inherited paths",
    proves: "No false positives. When there is nothing hidden, verify passes first time and no remediation runs.",
    world: w,
    approve: "all",
    expected: { assertions: [{ type: "github-no-access", repo: "docs-site", login: DEP.login }] },
  }));
}

const dir = path.join(process.cwd(), "src/eval/scenarios");
fs.mkdirSync(dir, { recursive: true });
for (const s of scenarios) {
  fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s, null, 2) + "\n");
}
console.log(`wrote ${scenarios.length} scenarios to ${dir}`);
