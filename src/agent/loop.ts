import Anthropic from "@anthropic-ai/sdk";
import type { Planner } from "@/core/executor";
import type { PlanDecision } from "@/actions/index";
import { OPERATION_NAMES } from "@/actions/index";
import { PLANNER_SYSTEM, plannerUserMessage } from "@/agent/prompts";
import { PLAN_SCHEMA } from "@/agent/tools";
import type { Tracer } from "@/core/trace";

export const PLANNER_MODEL = "claude-sonnet-5";

/** Coerce whatever the model actually sent into PlanDecision[]. Never throws. */
function normaliseDecisions(value: unknown): PlanDecision[] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .map((d) => {
      let params = d.params;
      if (typeof params === "string") {
        try {
          params = JSON.parse(params);
        } catch {
          params = {};
        }
      }
      return {
        id: String(d.id ?? ""),
        operation: String(d.operation ?? ""),
        params: (params && typeof params === "object" ? params : {}) as PlanDecision["params"],
        rationale: String(d.rationale ?? ""),
      } as PlanDecision;
    })
    .filter((d) => d.id && d.operation);
}

/** Exported for tests only. */
export const __normaliseDecisionsForTest = normaliseDecisions;

export class EmptyPlanError extends Error {
  constructor(readonly summary: string) {
    super("planner returned a summary but no decisions");
    this.name = "EmptyPlanError";
  }
}

/** Sonnet 5: $2 / MTok in, $10 / MTok out. */
export function sonnetCost(input: number, output: number): number {
  return (input / 1_000_000) * 2 + (output / 1_000_000) * 10;
}

export type PlanRecorder = {
  /** Replay a recorded plan instead of calling the model. */
  lookup?: (key: string) => { decisions: PlanDecision[]; summary: string; tokens?: { input: number; output: number } } | null;
  record?: (key: string, value: { decisions: PlanDecision[]; summary: string; tokens: { input: number; output: number } }) => void;
  key?: string;
};

export function makePlanner(tracer: Tracer, opts: { apiKey?: string; recorder?: PlanRecorder } = {}): Planner {
  const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});

  return async ({ discovery, violations, previous }) => {
    const cacheKey = `${opts.recorder?.key ?? "plan"}:${violations?.length ? "retry" : "first"}`;

    const replayed = opts.recorder?.lookup?.(cacheKey);
    if (replayed) {
      tracer.emit({
        type: "model", phase: "plan", label: `${PLANNER_MODEL} (replayed)`,
        tokens: replayed.tokens, costUsd: replayed.tokens ? sonnetCost(replayed.tokens.input, replayed.tokens.output) : 0,
        detail: { replayed: true, decisions: replayed.decisions.length },
      });
      return { decisions: replayed.decisions, summary: replayed.summary };
    }

    const user = plannerUserMessage(discovery, violations, previous);
    const t0 = Date.now();

    // Malformed plans are intermittent, not deterministic — the same prompt that
    // fails once succeeds on the next call. Retrying is the cheap fix; giving up
    // on the first bad response would make the whole run non-deterministic for no
    // reason. After the last attempt the error propagates and the run is rejected,
    // because a plan we could not read is never treated as a plan to do nothing.
    const MAX_ATTEMPTS = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await attemptPlan(attempt);
      } catch (err) {
        if (!(err instanceof EmptyPlanError) || attempt === MAX_ATTEMPTS) throw err;
        lastError = err;
        tracer.emit({
          type: "note", phase: "plan", label: `plan:retrying (attempt ${attempt} produced no decisions)`,
          ok: false, detail: { attempt, of: MAX_ATTEMPTS },
        });
      }
    }
    throw lastError ?? new Error("planner exhausted retries");

    async function attemptPlan(_attempt: number) {
    const response = await client.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: PLAN_SCHEMA } },
      system: PLANNER_SYSTEM,
      messages: [{ role: "user", content: `${user}\n\nReturn the plan as JSON matching the required schema.` }],
    });

    const tokens = { input: response.usage.input_tokens, output: response.usage.output_tokens };
    const costUsd = sonnetCost(tokens.input, tokens.output);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let parsed: { summary?: string; decisions?: unknown };
    try {
      parsed = JSON.parse(text) as { summary?: string; decisions?: unknown };
    } catch {
      tracer.emit({
        type: "model", phase: "plan", label: `${PLANNER_MODEL}:unparseable`, ok: false,
        tokens, costUsd, durationMs: Date.now() - t0,
        detail: { stopReason: response.stop_reason, head: text.slice(0, 200) },
      });
      throw new EmptyPlanError(text.slice(0, 200));
    }
    // Tool input is not guaranteed to arrive in the shape the schema describes.
    // Observed live: `decisions` came back as a JSON *string* rather than an
    // array, and `params` occasionally does the same. Normalise before touching
    // it — assuming the shape here throws a TypeError deep in the planner and
    // costs a whole run.
    const raw = normaliseDecisions(parsed.decisions);
    // Whitelist enforcement, in case a future model invents an operation name.
    const decisions = raw.filter((d) => (OPERATION_NAMES as string[]).includes(d.operation));
    const dropped = raw.length - decisions.length;

    // Observed in a live run: the model returned a coherent summary describing
    // eleven actions alongside an EMPTY decisions array. The summary is not the
    // plan, and a plan with no actions is a malformed response rather than a
    // decision to do nothing — the caller decides whether doing nothing is valid.
    if (decisions.length === 0) {
      tracer.emit({
        type: "model", phase: "plan", label: `${PLANNER_MODEL}:empty-plan`, ok: false,
        tokens, costUsd, durationMs: Date.now() - t0,
        detail: { stopReason: response.stop_reason, rawDecisions: raw.length, summary: parsed.summary },
      });
      throw new EmptyPlanError(parsed.summary ?? "");
    }

    tracer.emit({
      type: "model", phase: "plan", label: PLANNER_MODEL, ok: true,
      tokens, costUsd, durationMs: Date.now() - t0,
      detail: { decisions: decisions.length, droppedUnknownOperations: dropped, summary: parsed.summary },
    });

    opts.recorder?.record?.(cacheKey, { decisions, summary: parsed.summary ?? "", tokens });
    return { decisions, summary: parsed.summary ?? "" };
    }
  };
}
