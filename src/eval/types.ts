import type { WorldState } from "@/core/world";
import type { Fault } from "@/adapters/faults";
import type { OffboardTarget } from "@/core/config";

/**
 * An assertion about the END state of the world. Authored by hand in the fixture,
 * evaluated by src/eval/oracle.ts against the final WorldState.
 *
 * These are deliberately NOT the agent's postconditions. They are what a careful
 * human would check afterwards if they did not trust the agent at all.
 */
export type Assertion =
  | { type: "github-no-access"; repo: string; login: string }
  | { type: "github-has-access"; repo: string; login: string; atLeast?: string }
  | { type: "github-not-team-member"; slug: string; login: string }
  | { type: "github-not-org-member"; login: string }
  | { type: "drive-owner"; fileId: string; email: string }
  | { type: "drive-no-access"; fileId: string; email: string }
  | { type: "linear-issue-assignee"; issueId: string; assigneeId: string | null }
  | { type: "linear-not-team-member"; teamId: string; userId: string }
  | { type: "slack-message-contains"; channel: string; text: string }
  | { type: "world-unchanged" };

export type Scenario = {
  id: string;
  title: string;
  /** What failure mode this fixture exists to exercise. Printed in the report. */
  proves: string;
  world: WorldState;
  target: OffboardTarget;
  slackChannel: string;
  faults?: Fault[];
  /** Which irreversible actions the simulated human approves. "all" | "none" | list of operation names. */
  approve: "all" | "none" | string[];
  expected: {
    assertions: Assertion[];
    /** True when a correct run must abort and leave no partial state. */
    expectRollback?: boolean;
    /** True when the run is expected to end unresolved rather than verified. */
    expectUnresolved?: boolean;
  };
};
