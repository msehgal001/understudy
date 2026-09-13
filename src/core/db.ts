import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { RunResult } from "@/core/executor";
import type { TraceEvent } from "@/core/trace";

/**
 * Narrow surface on purpose: runs, events, approvals, idempotency keys. If
 * better-sqlite3 ever fails to build, node:sqlite's DatabaseSync exposes the same
 * exec/prepare shape and only this file changes.
 */
let db: Database.Database | null = null;

export function getDb(file = path.join(process.cwd(), "data/understudy.db")): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      target TEXT NOT NULL,
      org TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      phase TEXT,
      label TEXT NOT NULL,
      ok INTEGER,
      action_id TEXT,
      check_id TEXT,
      event_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      run_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      granted INTEGER NOT NULL,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (run_id, action_id)
    );
  `);
  return db;
}

export function saveRun(r: RunResult, meta: { mode: string; target: string; org: string }) {
  const d = getDb();
  d.prepare(
    `INSERT OR REPLACE INTO runs (id, created_at, mode, target, org, status, summary, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.runId, new Date().toISOString(), meta.mode, meta.target, meta.org, r.status, r.summary, JSON.stringify(r));
}

export function saveEvents(runId: string, events: TraceEvent[]) {
  const d = getDb();
  const stmt = d.prepare(
    `INSERT OR REPLACE INTO events (run_id, seq, ts, type, phase, label, ok, action_id, check_id, event_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = d.transaction((evts: TraceEvent[]) => {
    for (const e of evts) {
      stmt.run(runId, e.seq, e.ts, e.type, e.phase ?? null, e.label,
               e.ok === undefined ? null : e.ok ? 1 : 0, e.actionId ?? null, e.checkId ?? null, JSON.stringify(e));
    }
  });
  tx(events);
}

/**
 * Idempotency keys are scoped to the person being offboarded, not to a run — the
 * whole point is that a SECOND run for the same person skips work the first one
 * already did.
 *
 * This was previously stored against `run_id` and queried with
 * `run_id LIKE '%<login>%'`, which matched nothing, because a run id is
 * `run-<timestamp>` and never contains the login. The lookup silently returned
 * zero rows on every live run, so replay protection was dead code that looked
 * alive. Keyed by target now, and covered by a test.
 */
export function loadCompletedKeys(target: string): Set<string> {
  const d = getDb();
  const rows = d.prepare(`SELECT key FROM idempotency WHERE target = ?`).all(target) as { key: string }[];
  return new Set(rows.map((r) => r.key));
}

export function recordKeys(runId: string, target: string, keys: Set<string>) {
  const d = getDb();
  const stmt = d.prepare(`INSERT OR IGNORE INTO idempotency (key, run_id, target, created_at) VALUES (?, ?, ?, ?)`);
  const now = new Date().toISOString();
  const tx = d.transaction(() => { for (const k of keys) stmt.run(k, runId, target, now); });
  tx();
}

export function listRuns(limit = 50) {
  return getDb()
    .prepare(`SELECT id, created_at, mode, target, org, status, summary FROM runs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as { id: string; created_at: string; mode: string; target: string; org: string; status: string; summary: string }[];
}

export function getRun(id: string): RunResult | null {
  const row = getDb().prepare(`SELECT result_json FROM runs WHERE id = ?`).get(id) as { result_json: string } | undefined;
  return row ? (JSON.parse(row.result_json) as RunResult) : null;
}

export function getEvents(runId: string): TraceEvent[] {
  const rows = getDb().prepare(`SELECT event_json FROM events WHERE run_id = ? ORDER BY seq`).all(runId) as { event_json: string }[];
  return rows.map((r) => JSON.parse(r.event_json) as TraceEvent);
}
