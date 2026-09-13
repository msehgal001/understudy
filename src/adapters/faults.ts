/**
 * Deterministic fault injection for shadow adapters.
 *
 * Faults are declared in a scenario fixture, keyed by adapter method name, and
 * fire on a specific call index so a scenario replays identically every time.
 * Nothing here is random.
 */

export type Fault =
  /** Network/API timeout. Throws. */
  | { on: string; kind: "timeout"; atCall?: number }
  /** 429 with Retry-After. Throws a RateLimitError the executor knows to back off on. */
  | { on: string; kind: "rate-limit"; retryAfterMs: number; times: number }
  /**
   * A read that returns pre-write state, i.e. a stale cache. The dangerous one:
   * it makes a revocation look like it worked when it has not propagated, or makes
   * it look like it failed when it did. Either way the agent must not be fooled.
   */
  | { on: string; kind: "stale"; times: number };

export class RateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`rate limited, retry after ${retryAfterMs}ms`);
    this.name = "RateLimitError";
  }
}

export class TimeoutError extends Error {
  constructor(op: string) {
    super(`request timed out: ${op}`);
    this.name = "TimeoutError";
  }
}

export class FaultInjector {
  private calls = new Map<string, number>();
  private consumed = new Map<number, number>();

  constructor(private faults: Fault[] = []) {}

  /** Call at the top of every shadow adapter method. Returns "stale" to signal a pre-write read. */
  check(op: string): "ok" | "stale" {
    const n = (this.calls.get(op) ?? 0) + 1;
    this.calls.set(op, n);

    for (let i = 0; i < this.faults.length; i++) {
      const f = this.faults[i];
      if (f.on !== op) continue;
      const used = this.consumed.get(i) ?? 0;

      if (f.kind === "timeout") {
        if ((f.atCall ?? 1) === n) {
          this.consumed.set(i, used + 1);
          throw new TimeoutError(op);
        }
        continue;
      }
      if (f.kind === "rate-limit") {
        if (used < f.times) {
          this.consumed.set(i, used + 1);
          throw new RateLimitError(f.retryAfterMs);
        }
        continue;
      }
      if (f.kind === "stale") {
        if (used < f.times) {
          this.consumed.set(i, used + 1);
          return "stale";
        }
      }
    }
    return "ok";
  }
}
