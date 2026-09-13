import test from "node:test";
import assert from "node:assert/strict";
import { execute } from "@/core/executor";
import { adapterSet } from "@/adapters/registry";
import { Tracer } from "@/core/trace";
import { cloneWorld } from "@/core/world";
import fs from "node:fs";
import type { Scenario } from "@/eval/types";
import type { PlanDecision } from "@/actions/index";

const load = (id: string) => JSON.parse(fs.readFileSync(`src/eval/scenarios/${id}.json`, "utf8")) as Scenario;

/** A failing notification must not undo completed revocations. */
test("a failed notify action does not trigger rollback", async () => {
  const s = load("12-happy-path");
  const world = cloneWorld(s.world);
  const live = adapterSet("shadow", { world, faults: [{ on: "slack.postMessage", kind: "timeout", atCall: 1 }] });
  const shadow = adapterSet("shadow", { world: cloneWorld(s.world) });
  const tracer = new Tracer("test-notify", { memoryOnly: true });

  const decisions: PlanDecision[] = [
    { id: "revoke", operation: "github.removeCollaborator",
      params: { repo: "docs-site", login: s.target.githubLogin, previousPermission: "write" },
      rationale: "revoke" },
    { id: "report", operation: "slack.postReport", params: { text: "done" }, rationale: "notify" },
  ];

  const result = await execute({
    runId: "test-notify", tracer,
    build: { org: s.world.github.org, target: s.target, slackChannel: s.slackChannel },
    live, shadow,
    planner: async () => ({ decisions, summary: "test" }),
    approver: async () => new Set<string>(),
  });

  assert.equal(result.rollback, undefined, "a notify failure must not roll the run back");
  assert.equal(result.status, "unresolved", "the failure must still be reported, not buried");
  assert.equal(
    world.github.directCollaborators.filter((c) => c.repo === "docs-site" && c.login === s.target.githubLogin).length,
    0,
    "the revocation must stay applied",
  );
});

/** A real revoke failure must still roll back. */
test("a failed revoke action still triggers rollback", async () => {
  const s = load("12-happy-path");
  const world = cloneWorld(s.world);
  const live = adapterSet("shadow", { world, faults: [{ on: "github.removeCollaborator", kind: "timeout", atCall: 1 }] });
  const shadow = adapterSet("shadow", { world: cloneWorld(s.world) });
  const tracer = new Tracer("test-revoke", { memoryOnly: true });

  const decisions: PlanDecision[] = [
    { id: "reassign", operation: "linear.reassignIssue",
      params: { issueId: "i-1", assigneeId: "u-sam", previousAssigneeId: "u-dana" }, rationale: "transfer" },
    { id: "revoke", operation: "github.removeCollaborator",
      params: { repo: "docs-site", login: s.target.githubLogin, previousPermission: "write" }, rationale: "revoke" },
  ];

  const result = await execute({
    runId: "test-revoke", tracer,
    build: { org: s.world.github.org, target: s.target, slackChannel: s.slackChannel },
    live, shadow,
    planner: async () => ({ decisions, summary: "test" }),
    approver: async () => new Set<string>(),
  });

  assert.equal(result.status, "rolled-back");
  assert.equal(world.linear.issues.find((i) => i.id === "i-1")?.assigneeId, "u-dana", "the reassignment must be undone");
});
