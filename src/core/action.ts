import type { AdapterSet } from "@/adapters/types";
import type { App } from "@/core/world";
import type { Tracer } from "@/core/trace";

export type CheckResult = {
  pass: boolean;
  /** What was actually read back. Always recorded in the trace, pass or fail. */
  observed: unknown;
  note?: string;
  /**
   * The check could not determine an answer — the read itself failed, usually a
   * missing credential scope. This is NOT the same as a failed check, and
   * collapsing the two is its own kind of lie: one says "access still stands",
   * the other says "nobody knows". A run with unverifiable checks can never be
   * `verified`, but it is not reported as a detected failure either.
   */
  unverifiable?: boolean;
};

/** Thrown by an adapter when a read cannot be performed at all. */
export class UnverifiableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnverifiableError";
  }
}

/**
 * A Check receives adapters and a resource identity. That is all it receives.
 *
 * Note what is NOT in this type: the result of the write. Postconditions are
 * constructed in src/checks/postconditions.ts, a module that does not import the
 * action modules, so a write response is not in lexical scope to be captured.
 * See the header of that file for why this is structural separation rather than a
 * guarantee from the type system.
 */
export type CheckContext = { adapters: AdapterSet };

export type Check = {
  id: string;
  describe: string;
  run(ctx: CheckContext): Promise<CheckResult>;
};

export type ApplyResult = { status: number; body: unknown };

export type ActionKind = "revoke" | "transfer" | "archive" | "notify";

export type Action = {
  id: string;
  app: App;
  kind: ActionKind;
  description: string;
  /** false forces a human approval gate before commit. */
  reversible: boolean;
  /** Stable across replays of the same logical change; recorded before the call. */
  idempotencyKey: string;
  /** Used to enforce transfer-before-revoke ordering per resource. */
  resourceId: string;
  preconditions: Check[];
  postconditions: Check[];
  apply(ctx: ActionContext): Promise<ApplyResult>;
  inverse(ctx: ActionContext): Promise<void>;
};

export type ActionContext = { adapters: AdapterSet; tracer: Tracer };

export class IrreversibleError extends Error {
  constructor(actionId: string) {
    super(`action ${actionId} is not reversible; inverse() must never be called`);
    this.name = "IrreversibleError";
  }
}

export function irreversible(actionId: string): () => Promise<never> {
  return async () => {
    throw new IrreversibleError(actionId);
  };
}
