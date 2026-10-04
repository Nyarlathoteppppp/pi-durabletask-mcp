import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_DIR, STATE_DIR } from "./config.js";
import { catalogSession } from "./durable.js";
import { loaded } from "./registry.js";
import { resolveDelegateCwd } from "./workspace.js";

/**
 * Handoff notes let a new Claude/Codex window pick up where the previous one left a Pi session.
 * They hold only the calling agent's summary and which session it concerns. The session's real
 * state is always read live, without taking its lock, so handoff never affects ownership,
 * recovery or retention, and a note can outlive its session.
 */

export type ResumeHint =
  | "wait_running_session"
  | "status_then_follow_up"
  | "old_process_owns_session"
  | "awaiting_recovery"
  | "session_not_recoverable"
  | "session_missing";

const HINTS: Record<ResumeHint, string> = {
  wait_running_session: "It is running in this process. Call wait with this sessionId and until \"settled\".",
  status_then_follow_up: "It has finished. Call status for its result, then follow_up with `next` if the work should continue.",
  old_process_owns_session: "It is unfinished and another MCP process still holds it, most likely the previous window. " +
    "Close that window: a running MCP process then resumes it within about 30 seconds, usually this one but " +
    "possibly another open window (status here also prompts an attempt). " +
    "Or let it finish there; status reads the result here once it has. Do not spawn a duplicate.",
  awaiting_recovery: "It is unfinished and no process holds it; a process resumes it when a delegate slot is free. Call status shortly.",
  session_not_recoverable: "It was a memory-only session and lives only in the MCP process that started it, which is not this one. " +
    "If the previous window is closed it is gone: use goal, completed and next to spawn new work.",
  session_missing: "It was deleted (forget or retention), or its id now names a different session. Use goal, completed and next to spawn new work.",
};

export interface HandoffNote {
  name: string;
  cwd: string;
  sessionId: string;
  durable: boolean;
  goal: string;
  completed: string;
  next: string;
  savedAt: string;
}

let store: DatabaseSync | undefined;
function db(): DatabaseSync {
  if (store) return store;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const path = join(STATE_DIR, "handoff.sqlite");
  const opened = new DatabaseSync(path);
  // One note per (agent dir, repository, name); saving again replaces it, so the table stays small.
  opened.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS handoffs (agent_dir TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT NOT NULL,
      session_id TEXT NOT NULL, session_started_at TEXT, durable INTEGER NOT NULL,
      goal TEXT NOT NULL, completed TEXT NOT NULL, next TEXT NOT NULL, saved_at TEXT NOT NULL,
      seq INTEGER NOT NULL, PRIMARY KEY (agent_dir, cwd, name));`);
  // Tables from the first handoff commit lack seq; number their rows by saved_at, then insertion.
  // One write transaction, checked inside it, so two processes opening it together migrate once.
  const hasSeq = (): boolean => (opened.prepare("PRAGMA table_info(handoffs)").all() as { name: string }[]).some((c) => c.name === "seq");
  if (!hasSeq()) {
    opened.exec("BEGIN IMMEDIATE");
    try {
      if (!hasSeq()) opened.exec(`ALTER TABLE handoffs ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
        UPDATE handoffs SET seq = (SELECT n FROM (SELECT rowid AS id, row_number() OVER (ORDER BY saved_at, rowid) AS n
          FROM handoffs) WHERE id = handoffs.rowid);`);
      opened.exec("COMMIT");
    } catch (error) { opened.exec("ROLLBACK"); opened.close(); throw error; }
  }
  chmodSync(path, 0o600);
  return store = opened;
}

/**
 * The session behind an id, as far as this process can see it without taking a lock. A durable
 * session's identity is the start time in the catalog, whoever has it loaded, so a note saved in
 * one process compares with the same value in another.
 */
function lookup(sessionId: string): { startedAt?: string; durable: boolean; cwd?: string } | undefined {
  const worker = loaded(sessionId);
  if (worker && !worker.durable) return { startedAt: worker.startedAt, durable: false, cwd: worker.cwd };
  const stored = catalogSession(sessionId);
  return stored ? { startedAt: stored.startedAt, durable: true, cwd: stored.cwd } : undefined;
}

export interface SaveRequest {
  cwd: string;
  name?: string | undefined;
  sessionId: string;
  goal: string;
  completed: string;
  next: string;
}

export async function saveHandoff(req: SaveRequest): Promise<{ saved: HandoffNote; warning?: string }> {
  const cwd = await resolveDelegateCwd(req.cwd);
  const session = lookup(req.sessionId);
  if (!session)
    throw new Error(`Unknown sessionId: ${req.sessionId}. A handoff names a session this process runs, or a durable one.`);
  // A note is found by repository; it must not point a new window at another repository's session.
  if (session.cwd && session.cwd !== cwd)
    throw new Error(`Session ${req.sessionId} works in ${session.cwd}, not ${cwd}. Save the handoff with that cwd.`);
  const note: HandoffNote = { name: req.name ?? "", cwd, sessionId: req.sessionId, durable: session.durable,
    goal: req.goal, completed: req.completed, next: req.next, savedAt: new Date().toISOString() };
  // seq orders saves exactly: two saves can share a millisecond, and an upsert keeps its rowid.
  db().prepare(`INSERT INTO handoffs (agent_dir, cwd, name, session_id, session_started_at, durable, goal, completed, next, saved_at, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM handoffs))
    ON CONFLICT (agent_dir, cwd, name) DO UPDATE SET session_id = excluded.session_id,
      session_started_at = excluded.session_started_at, durable = excluded.durable, goal = excluded.goal,
      completed = excluded.completed, next = excluded.next, saved_at = excluded.saved_at, seq = excluded.seq`)
    .run(AGENT_DIR, cwd, note.name, note.sessionId, session.startedAt ?? null, note.durable ? 1 : 0,
      note.goal, note.completed, note.next, note.savedAt);
  return session.durable ? { saved: note } : { saved: note, warning:
    "This session is memory-only: a new window runs a new MCP process, which cannot continue or read it. " +
    "Put what matters into completed now, and use durable: true for work meant to be handed over." };
}

type Row = { name: string; cwd: string; session_id: string; session_started_at: string | null; durable: number;
  goal: string; completed: string; next: string; saved_at: string };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * How to resume, from live state. Reads only; never claims, loads or locks the session.
 * heldElsewhere is advisory: the catalog pid of the last claimer is alive and not this process.
 * After a crash that pid can be reused by an unrelated process; the hint can then be wrong.
 */
function resumeHint(row: Row): { hint: ResumeHint; heldElsewhere?: boolean } {
  const startedAt = row.session_started_at ?? undefined;
  const worker = loaded(row.session_id);
  if (!row.durable) {
    if (!worker || (startedAt && worker.startedAt !== startedAt)) return { hint: worker ? "session_missing" : "session_not_recoverable" };
    return { hint: worker.isActive ? "wait_running_session" : "status_then_follow_up" };
  }
  const stored = catalogSession(row.session_id);
  if (!stored || (startedAt && stored.startedAt && stored.startedAt !== startedAt)) return { hint: "session_missing" };
  if (worker) return { hint: worker.isActive ? "wait_running_session" : "status_then_follow_up" };
  const heldElsewhere = stored.pid !== 0 && stored.pid !== process.pid && alive(stored.pid);
  if (stored.finished) return { hint: "status_then_follow_up", ...(heldElsewhere ? { heldElsewhere } : {}) };
  return { hint: heldElsewhere ? "old_process_owns_session" : "awaiting_recovery" };
}

export async function readHandoff(cwdInput: string, name?: string) {
  const cwd = await resolveDelegateCwd(cwdInput);
  const rows = db().prepare("SELECT * FROM handoffs WHERE agent_dir = ? AND cwd = ? ORDER BY seq DESC")
    .all(AGENT_DIR, cwd) as Row[];
  const row = name === undefined ? rows[0] : rows.find((r) => r.name === name);
  if (!row) return { found: false as const, cwd, ...(rows.length ? { names: rows.map((r) => r.name) } : {}),
    message: name === undefined ? "No handoff found for this repository." : `No handoff named "${name}" for this repository.` };
  const { hint, heldElsewhere } = resumeHint(row);
  return {
    found: true as const,
    handoff: { name: row.name, cwd: row.cwd, sessionId: row.session_id, durable: row.durable === 1,
      goal: row.goal, completed: row.completed, next: row.next, savedAt: row.saved_at } satisfies HandoffNote,
    resumeHint: hint,
    howToResume: heldElsewhere
      ? `${HINTS[hint]} Another MCP process (likely the previous window) has it loaded, so follow_up works only after that window closes; status works now.`
      : HINTS[hint],
    ...(heldElsewhere ? { heldByAnotherProcess: true } : {}),
    // Other notes for this repository, newest first, so a caller can pick one by name.
    ...(rows.length > 1 ? { names: rows.map((r) => r.name) } : {}),
  };
}
