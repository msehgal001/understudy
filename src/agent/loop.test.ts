import test from "node:test";
import assert from "node:assert/strict";
import { __normaliseDecisionsForTest as normalise } from "@/agent/loop";

/**
 * Tool input does not always arrive in the shape the schema describes. Each of
 * these was either observed live or is one mutation away from something that was.
 */
test("accepts a well-formed decisions array", () => {
  const out = normalise([{ id: "a", operation: "github.removeCollaborator", params: { repo: "r" }, rationale: "x" }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].params, { repo: "r" });
});

test("parses decisions delivered as a JSON string", () => {
  const out = normalise(JSON.stringify([{ id: "a", operation: "slack.postReport", params: {}, rationale: "x" }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].operation, "slack.postReport");
});

test("parses params delivered as a JSON string", () => {
  const out = normalise([{ id: "a", operation: "github.removeCollaborator", params: '{"repo":"r"}', rationale: "x" }]);
  assert.deepEqual(out[0].params, { repo: "r" });
});

test("returns empty for unparseable or wrong-typed input rather than throwing", () => {
  assert.deepEqual(normalise("not json at all"), []);
  assert.deepEqual(normalise({ nope: true }), []);
  assert.deepEqual(normalise(null), []);
  assert.deepEqual(normalise(undefined), []);
});

test("drops entries missing an id or operation", () => {
  const out = normalise([{ id: "", operation: "x", params: {}, rationale: "" }, { id: "b", operation: "", params: {}, rationale: "" }]);
  assert.equal(out.length, 0);
});
