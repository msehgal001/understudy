import test from "node:test";
import assert from "node:assert/strict";
import { bareRepo, materialize } from "@/actions/index";

/**
 * The model reads repository names from a survey that prints them org-qualified,
 * and supplies them back either way. A qualified name passed through produced
 * `/repos/acme-co/acme-co%2Frepo/...`, failing every precondition so the revoke
 * never ran — while the run still reported all evaluated postconditions passing.
 */
test("strips the org prefix when present", () => {
  assert.equal(bareRepo("acme-co/payments-core", "acme-co"), "payments-core");
});

test("leaves a bare name untouched", () => {
  assert.equal(bareRepo("payments-core", "acme-co"), "payments-core");
});

test("is case-insensitive about the org", () => {
  assert.equal(bareRepo("ACME-CO/payments-core", "acme-co"), "payments-core");
});

test("takes the last segment for any other owner/name shape", () => {
  assert.equal(bareRepo("someone-else/payments-core", "acme-co"), "payments-core");
});

test("handles empty and missing values without throwing", () => {
  assert.equal(bareRepo(undefined, "acme-co"), "");
  assert.equal(bareRepo("", "acme-co"), "");
});

test("a qualified repo name produces the correct idempotency key end to end", () => {
  const [action] = materialize(
    [{ id: "a", operation: "github.removeCollaborator",
       params: { repo: "acme-co/payments-core", login: "dana", previousPermission: "write" }, rationale: "" }],
    { org: "acme-co", target: { githubLogin: "dana", email: "d@x.com", name: "D", successorEmail: "s@x.com", successorGithubLogin: "s" }, slackChannel: "#c" },
  );
  assert.equal(action.idempotencyKey, "gh:rm-collab:acme-co/payments-core:dana");
  assert.match(action.description, /acme-co\/payments-core/);
});
