import test from "node:test";
import assert from "node:assert/strict";
import { validateOrdering } from "@/core/ordering";
import type { Action } from "@/core/action";

const act = (id: string, kind: Action["kind"], resourceId: string): Action =>
  ({ id, kind, resourceId, app: "drive", description: id, reversible: true, idempotencyKey: id,
     preconditions: [], postconditions: [], apply: async () => ({ status: 200, body: null }), inverse: async () => {} });

test("flags a revoke ordered before a transfer on the same resource", () => {
  const v = validateOrdering([act("r1", "revoke", "drive:f1"), act("t1", "transfer", "drive:f1")]);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /Transfers must come first/);
});

test("accepts transfer before revoke", () => {
  assert.equal(validateOrdering([act("t1", "transfer", "drive:f1"), act("r1", "revoke", "drive:f1")]).length, 0);
});

test("ignores ordering across different resources", () => {
  assert.equal(validateOrdering([act("r1", "revoke", "drive:f1"), act("t1", "transfer", "drive:f2")]).length, 0);
});
