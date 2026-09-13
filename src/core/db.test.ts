import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb, recordKeys, loadCompletedKeys } from "@/core/db";

/**
 * Regression test for a bug that made replay protection dead code: keys were
 * stored against run_id and looked up with `run_id LIKE '%<login>%'`, which never
 * matched because a run id is `run-<timestamp>`. The lookup returned zero rows on
 * every live run while appearing to work.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "understudy-db-"));
getDb(path.join(dir, "test.db"));

test("idempotency keys are recoverable by target across different runs", () => {
  recordKeys("run-aaa111", "dana-departing", new Set(["gh:rm-collab:org/repo:dana-departing"]));

  // A later run for the same person must see the earlier run's keys.
  const keys = loadCompletedKeys("dana-departing");
  assert.ok(keys.has("gh:rm-collab:org/repo:dana-departing"), "a second run must skip work the first already did");
});

test("keys are scoped per target, not shared between people", () => {
  recordKeys("run-bbb222", "someone-else", new Set(["gh:rm-collab:org/repo:someone-else"]));
  const dana = loadCompletedKeys("dana-departing");
  assert.equal(dana.has("gh:rm-collab:org/repo:someone-else"), false, "another person's keys must not leak in");
});

test("an unknown target has no completed keys", () => {
  assert.equal(loadCompletedKeys("never-seen").size, 0);
});
