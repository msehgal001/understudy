import test from "node:test";
import assert from "node:assert/strict";
import { normalizePermission, toGithubWire } from "@/adapters/github/live";
import type { GithubPermission } from "@/core/world";

/**
 * Live/shadow contract test.
 *
 * GitHub returns repo-team permissions in its legacy vocabulary ("pull"/"push")
 * and role names in the modern one ("read"/"write"). The shadow world ranks only
 * the modern set, so an un-normalised "push" fell out of the rank table as
 * undefined and a team-derived WRITE grant became invisible to rehearsal in live
 * mode. Nothing caught it, because the eval's "live" adapter is itself a shadow.
 * This test is the contract those two implementations must both satisfy.
 */
const RANKED: GithubPermission[] = ["none", "read", "triage", "write", "maintain", "admin"];

test("every legacy permission normalises into the ranked vocabulary", () => {
  for (const legacy of ["pull", "triage", "push", "maintain", "admin"]) {
    const got = normalizePermission(legacy);
    assert.ok(RANKED.includes(got), `"${legacy}" normalised to "${got}", which the world cannot rank`);
  }
  assert.equal(normalizePermission("pull"), "read");
  assert.equal(normalizePermission("push"), "write");
});

test("a team-derived write grant does not silently rank as none", () => {
  // The exact regression: "push" must not collapse to "none".
  assert.notEqual(normalizePermission("push"), "none");
  assert.equal(RANKED.indexOf(normalizePermission("push")) > RANKED.indexOf("read"), true);
});

test("modern names pass through unchanged", () => {
  for (const p of RANKED) assert.equal(normalizePermission(p), p);
});

test("unknown and missing values fail closed to none", () => {
  assert.equal(normalizePermission(undefined), "none");
  assert.equal(normalizePermission(null), "none");
  assert.equal(normalizePermission("write-ish"), "none");
});

test("writes are sent back in the vocabulary GitHub accepts", () => {
  // GitHub rejects "read"/"write" on PUT /repos/{o}/{r}/collaborators/{u}.
  assert.equal(toGithubWire("read"), "pull");
  assert.equal(toGithubWire("write"), "push");
  assert.equal(toGithubWire("admin"), "admin");
});

test("normalize and wire round-trip", () => {
  for (const p of RANKED) assert.equal(normalizePermission(toGithubWire(p)), p);
});
