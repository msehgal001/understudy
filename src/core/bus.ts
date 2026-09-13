import type { TraceEvent } from "@/core/trace";

/**
 * In-process pub/sub for live run progress. Deliberately not durable: the JSONL
 * trace and SQLite are the record, this only exists so the console can watch a
 * run happen. A dropped subscriber loses nothing that matters.
 */
type Entry = { events: TraceEvent[]; done: boolean; subscribers: Set<(e: TraceEvent | { done: true }) => void> };

const runs = new Map<string, Entry>();

export function startRun(runId: string): Entry {
  const entry: Entry = { events: [], done: false, subscribers: new Set() };
  runs.set(runId, entry);
  return entry;
}

export function publish(runId: string, e: TraceEvent) {
  const entry = runs.get(runId);
  if (!entry) return;
  entry.events.push(e);
  for (const s of entry.subscribers) { try { s(e); } catch { /* ignore */ } }
}

export function finishRun(runId: string) {
  const entry = runs.get(runId);
  if (!entry) return;
  entry.done = true;
  for (const s of entry.subscribers) { try { s({ done: true }); } catch { /* ignore */ } }
  // Keep the buffer briefly so a late subscriber can replay, then drop it.
  setTimeout(() => runs.delete(runId), 60_000);
}

export function subscribe(runId: string, fn: (e: TraceEvent | { done: true }) => void): () => void {
  const entry = runs.get(runId);
  if (!entry) { fn({ done: true }); return () => {}; }
  for (const e of entry.events) fn(e);
  if (entry.done) { fn({ done: true }); return () => {}; }
  entry.subscribers.add(fn);
  return () => entry.subscribers.delete(fn);
}

export function isActive(runId: string) {
  return runs.has(runId) && !runs.get(runId)!.done;
}
