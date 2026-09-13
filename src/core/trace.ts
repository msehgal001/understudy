import fs from "node:fs";
import path from "node:path";

export type Phase = "discover" | "plan" | "rehearse" | "approve" | "commit" | "verify" | "judge";

export type TraceEvent = {
  seq: number;
  ts: string;
  runId: string;
  type:
    | "phase"
    | "model"
    | "tool"
    | "precondition"
    | "postcondition"
    | "action"
    | "rollback"
    | "remediation"
    | "note";
  phase?: Phase;
  label: string;
  ok?: boolean;
  actionId?: string;
  checkId?: string;
  observed?: unknown;
  detail?: unknown;
  durationMs?: number;
  tokens?: { input: number; output: number };
  costUsd?: number;
};

export type TraceSink = (e: TraceEvent) => void;

/**
 * Append-only JSONL. This file is the artifact the eval harness scores and the
 * trace judge reads — neither of them reads the agent's own summary, because a
 * summary is exactly the thing under suspicion.
 */
export class Tracer {
  private seq = 0;
  private stream?: fs.WriteStream;
  readonly events: TraceEvent[] = [];
  private sinks: TraceSink[] = [];

  constructor(
    readonly runId: string,
    opts: { dir?: string; memoryOnly?: boolean } = {},
  ) {
    if (!opts.memoryOnly) {
      const dir = opts.dir ?? path.join(process.cwd(), "traces");
      fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(path.join(dir, `${runId}.jsonl`), { flags: "a" });
    }
  }

  subscribe(sink: TraceSink) {
    this.sinks.push(sink);
    return () => {
      this.sinks = this.sinks.filter((s) => s !== sink);
    };
  }

  emit(e: Omit<TraceEvent, "seq" | "ts" | "runId">): TraceEvent {
    const full: TraceEvent = { ...e, seq: ++this.seq, ts: new Date().toISOString(), runId: this.runId };
    this.events.push(full);
    this.stream?.write(JSON.stringify(full) + "\n");
    for (const s of this.sinks) {
      try {
        s(full);
      } catch {
        /* a broken SSE client must never break a run */
      }
    }
    return full;
  }

  async span<T>(e: Omit<TraceEvent, "seq" | "ts" | "runId" | "durationMs">, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      const out = await fn();
      this.emit({ ...e, durationMs: Date.now() - t0, ok: e.ok ?? true });
      return out;
    } catch (err) {
      this.emit({
        ...e,
        ok: false,
        durationMs: Date.now() - t0,
        detail: { ...(e.detail as object), error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  totals() {
    let input = 0, output = 0, costUsd = 0;
    for (const e of this.events) {
      if (e.tokens) { input += e.tokens.input; output += e.tokens.output; }
      if (e.costUsd) costUsd += e.costUsd;
    }
    return { input, output, costUsd };
  }

  close() {
    this.stream?.end();
  }
}

export function readTrace(file: string): TraceEvent[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEvent);
}
