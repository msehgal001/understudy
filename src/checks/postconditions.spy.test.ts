import test from "node:test";
import assert from "node:assert/strict";
import { ALL_POSTCONDITION_FACTORIES } from "@/checks/postconditions";
import type { AdapterSet } from "@/adapters/types";

/**
 * The test that makes the reliability claim checkable.
 *
 * Every postcondition is run against an adapter set that records each call. A
 * check that returns a verdict without issuing at least one read is answering
 * from memory rather than from the API — the precise failure this project exists
 * to prevent — and fails here.
 */

function spyAdapters(): { adapters: AdapterSet; calls: string[] } {
  const calls: string[] = [];
  const app = (name: string) =>
    new Proxy(
      { mode: "shadow" },
      {
        get(_t, prop: string) {
          if (prop === "mode") return "shadow";
          return async (...args: unknown[]) => {
            calls.push(`${name}.${prop}`);
            return emptyReturnFor(prop, args);
          };
        },
      },
    );
  return {
    adapters: {
      mode: "shadow",
      github: app("github"),
      drive: app("drive"),
      linear: app("linear"),
      slack: app("slack"),
    } as unknown as AdapterSet,
    calls,
  };
}

/** Shapes just real enough that the checks can run to completion. */
function emptyReturnFor(prop: string, _args: unknown[]): unknown {
  if (prop === "getEffectivePermission") return { permission: "none" };
  if (prop === "getOrgMembership") return { state: "none", role: "none" };
  if (prop === "getOrgDefaultRepoPermission") return "none";
  if (prop === "getFile") return null;
  if (prop === "getIssue") return null;
  if (prop === "getTeam") return null;
  if (prop.startsWith("list")) return [];
  return { status: 200, body: null };
}

for (const [name, make] of Object.entries(ALL_POSTCONDITION_FACTORIES)) {
  test(`postcondition ${name} reads live state before returning a verdict`, async () => {
    const { adapters, calls } = spyAdapters();
    const check = make();
    const result = await check.run({ adapters });

    assert.ok(
      calls.length > 0,
      `${name} returned { pass: ${result.pass} } without calling any adapter method. ` +
        `A postcondition must re-read from the API, never answer from the write it followed.`,
    );
    assert.equal(typeof result.pass, "boolean", `${name} must return a boolean verdict`);
    assert.ok("observed" in result, `${name} must record what it observed`);
  });
}
