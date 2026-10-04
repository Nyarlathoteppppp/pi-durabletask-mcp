import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry, defineDoc, defineExtension, defineTask, Harness,
  type Cursor, type HarnessOptions, type TaskId, type TaskRuntime,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, DAY_MS, MAX_RECOVERY_ATTEMPTS, RETENTION_DAYS, STATE_DIR, STORAGE_LIMIT_BYTES } from "./config.js";
import { initOwnership, owns, release as releaseOwnership, removeTombstones, tryAcquire } from "./ownership.js";
import { getRuntime } from "./pi/runtime.js";
import type { WorkerOptions } from "./pi/worker.js";
import type { Snapshot } from "./types.js";

/**
 * Version of the ownership protocol, and of the namespace it owns. v1 kept `durable/catalog.sqlite`
 * and `durable/<key>/`, owned by PID; v1 hosts still running from an older build use only those.
 * v2 owns jobs through kernel locks (see ownership.ts) and keeps everything under `durable/v2/`.
 * The two never see each other's jobs, so mixed builds cannot both own a store. A future protocol
 * takes a new directory the same way.
 */
export const OWNERSHIP_PROTOCOL = 2;
export const DURABLE_DIR = join(STATE_DIR, "durable", `v${OWNERSHIP_PROTOCOL}`);
const JOBS_DIR = join(DURABLE_DIR, "jobs");
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function jobDir(key: string): string {
  if (!KEY.test(key)) throw new Error(`Invalid durable job key: ${key}`);
  return join(JOBS_DIR, key);
}
const context = BACKGROUND_CONTEXT;

export interface Checkpoint {
  phase: "execute";
  entries: FileEntry[];
  snapshot: Snapshot;
  inputStarted: boolean;
  results: Record<string, { content: unknown; details?: unknown; isError: boolean; name: string; parentToolCallId?: string }>;
  steering: string[];
  recoveryInput?: { text: string; steeringCount: number };
}
const CurrentTask = defineDoc<{ taskId: number | null }>({
  kind: "pi-delegate.current-task", version: 1, scope: "session", initial: () => ({ taskId: null }),
});
interface Input { prompt: string; checkpoint: Checkpoint }
export interface JobRecord { key: string; options: WorkerOptions; prompt: string }
type Row = { key: string; options: string; prompt: string };
type Execute = (prompt: string, saved: Checkpoint, signal: AbortSignal) => Promise<Checkpoint>;

/** What a worker persists through: a DurableJob, or a MemoryJob for `durable: false`. */
export interface JobStore {
  readonly needsResume: boolean;
  save(checkpoint: Checkpoint): Promise<void>;
  begin(prompt: string, checkpoint: Checkpoint, execute: Execute, recover?: boolean): Promise<{ done: Promise<Checkpoint> }>;
  close(release?: boolean): Promise<void>;
  forget(): Promise<void>;
  /** The finished state, kept where every process can read it. */
  recordFinal(snapshot: Snapshot): void;
}

/**
 * Non-durable delegates run through this. Nothing reaches the catalog, a lock or SQLite; the
 * delegate lives as long as this process and cannot be recovered after it exits.
 */
export class MemoryJob implements JobStore {
  readonly needsResume = false;
  private controller = new AbortController();
  save(): Promise<void> { return Promise.resolve(); }
  async begin(prompt: string, checkpoint: Checkpoint, execute: Execute): Promise<{ done: Promise<Checkpoint> }> {
    this.controller = new AbortController();
    return { done: execute(prompt, checkpoint, this.controller.signal) };
  }
  /** Like closing a Harness, this cancels a running execution. */
  async close(): Promise<void> { this.controller.abort(); }
  async forget(): Promise<void> { this.controller.abort(); }
  recordFinal(): void {}
}

let catalog: DatabaseSync | undefined;
let uniqueIds = true;
function db(): DatabaseSync {
  if (catalog) return catalog;
  for (const dir of [DURABLE_DIR, JOBS_DIR]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
  initOwnership(join(DURABLE_DIR, "ownership"));
  const path = join(DURABLE_DIR, "catalog.sqlite");
  const opened = new DatabaseSync(path);
  // pid is diagnostic only; ownership is the lock. attempts counts claims since the job last
  // made progress, so a job that kills its host on recovery cannot crash every host in turn.
  opened.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  // Check an existing catalog's protocol before touching its schema.
  const hasMeta = opened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined;
  const existing = hasMeta
    ? (opened.prepare("SELECT value FROM meta WHERE name = 'ownership_protocol'").get() as { value: string } | undefined)?.value
    : undefined;
  if (hasMeta && existing !== String(OWNERSHIP_PROTOCOL)) {
    opened.close();
    throw new Error(`${path} uses ownership protocol ${existing ?? "(missing)"}; this build speaks ${OWNERSHIP_PROTOCOL}`);
  }
  if (!hasMeta) {
    // Create the table and its protocol together, so a crash cannot leave a meta without one.
    opened.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('ownership_protocol', '${OWNERSHIP_PROTOCOL}');
      COMMIT;`);
  }
  opened.exec(`
    CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, pid INTEGER NOT NULL, agent_dir TEXT NOT NULL,
      options TEXT NOT NULL, prompt TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, finished_at INTEGER,
      snapshot TEXT);`);
  // finished_at is set while the current task is terminal and cleared by follow_up. Only finished
  // jobs are swept, and recovery claims only unfinished ones. Added after the first v2 catalogs.
  // snapshot holds the finished state, so any process can show it without loading the store.
  const columns = new Set((opened.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
  if (!columns.has("finished_at")) opened.exec("ALTER TABLE jobs ADD COLUMN finished_at INTEGER");
  if (!columns.has("snapshot")) opened.exec("ALTER TABLE jobs ADD COLUMN snapshot TEXT");
  // Session ids are unique per agent dir across every process. A pre-check alone races: two
  // processes could both find an id free and insert it under different job keys.
  try {
    opened.exec("CREATE UNIQUE INDEX IF NOT EXISTS jobs_session ON jobs (agent_dir, json_extract(options, '$.id'))");
    uniqueIds = true;
  } catch (error) {
    // A catalog that already holds duplicate ids still opens, so its jobs stay readable and can be
    // forgotten, but no durable job is created until the index exists: without it two processes
    // could again insert the same id.
    uniqueIds = false;
    process.stderr.write(`[pi-delegate] session ids are not unique in ${path}; forget duplicates to fix: ${String(error)}\n`);
  }
  chmodSync(path, 0o600);
  return catalog = opened;
}

/**
 * Claim unowned jobs. The lock decides ownership; the row is read again after locking because a
 * concurrent forget deletes the row before it releases the lock.
 */
/**
 * `contended` counts jobs whose lock was busy. Usually a live owner holds it, but two processes
 * claiming the same job at the same instant can also both see it busy and both back off: each
 * holds a shared lock while the other tries to upgrade. Callers retry once after a random delay.
 */
export function claimAbandoned(excludeIds: Set<string>, limit: number): { records: JobRecord[]; contended: number } {
  const records: JobRecord[] = [];
  let contended = 0;
  const rows = db().prepare("SELECT key, options, prompt FROM jobs WHERE agent_dir = ? AND finished_at IS NULL ORDER BY rowid DESC");
  for (const row of rows.all(AGENT_DIR) as Row[]) {
    if (records.length >= limit) break;
    if (owns(row.key)) continue;
    const options = JSON.parse(row.options) as WorkerOptions;
    if (options.id && excludeIds.has(options.id)) continue;
    if (!tryAcquire(row.key)) { contended++; continue; }
    const fresh = db().prepare("SELECT attempts FROM jobs WHERE key = ?").get(row.key) as { attempts: number } | undefined;
    if (!fresh) { releaseOwnership(row.key); continue; }
    db().prepare("UPDATE jobs SET pid = ?, attempts = ? WHERE key = ?").run(process.pid, fresh.attempts + 1, row.key);
    records.push({ key: row.key, options, prompt: row.prompt });
    if (options.id) excludeIds.add(options.id);
  }
  return { records, contended };
}

/** A short random pause, so processes that collided on a lock do not collide again. */
export const jitter = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 150));

/**
 * claimAbandoned with one jittered second look when nothing was claimed but some lock was busy.
 * Without it, two processes starting together can both back off and leave the job unclaimed
 * until something else triggers recovery.
 */
export async function claimAbandonedSettled(
  budget: () => { excludeIds: Set<string>; limit: number } | undefined,
): Promise<JobRecord[]> {
  // Read the budget right before each attempt: during the wait, new work can fill the slots or
  // shutdown can begin. undefined (or no slots) means claim nothing.
  const attempt = (): { records: JobRecord[]; contended: number } => {
    const now = budget();
    return now && now.limit > 0 ? claimAbandoned(now.excludeIds, now.limit) : { records: [], contended: 0 };
  };
  const first = attempt();
  if (first.records.length || !first.contended) return first.records;
  await jitter();
  return attempt().records;
}

const byId = (id: string): Row | undefined => db().prepare(
  "SELECT key, options, prompt FROM jobs WHERE agent_dir = ? AND json_extract(options, '$.id') = ? ORDER BY rowid DESC LIMIT 1",
).get(AGENT_DIR, id) as Row | undefined;

/**
 * The recorded final state of a finished job, read without its lock, so a session loaded by
 * another process stays readable. Undefined while it runs, or if it finished before recording.
 */
export function storedSnapshot(id: string): Snapshot | undefined {
  const row = db().prepare(
    "SELECT snapshot FROM jobs WHERE agent_dir = ? AND json_extract(options, '$.id') = ? AND finished_at IS NOT NULL " +
    "AND snapshot IS NOT NULL ORDER BY rowid DESC LIMIT 1",
  ).get(AGENT_DIR, id) as { snapshot: string } | undefined;
  return row ? JSON.parse(row.snapshot) as Snapshot : undefined;
}

/**
 * What the catalog says about a durable session, read without its lock: for callers that only
 * describe a session (handoff), never for ownership decisions. pid is the last claimer, maybe dead.
 */
export function catalogSession(id: string): { pid: number; finished: boolean; startedAt?: string; cwd?: string } | undefined {
  const row = db().prepare(
    "SELECT pid, finished_at, options FROM jobs WHERE agent_dir = ? AND json_extract(options, '$.id') = ? ORDER BY rowid DESC LIMIT 1",
  ).get(AGENT_DIR, id) as { pid: number; finished_at: number | null; options: string } | undefined;
  if (!row) return undefined;
  const options = JSON.parse(row.options) as WorkerOptions;
  return { pid: row.pid, finished: row.finished_at !== null, startedAt: options.startedAt, cwd: options.cwd };
}

/** True when a stored job, in any process, already uses this session id. */
export const storedIdInUse = (id: string): boolean => byId(id) !== undefined;

/**
 * Claim a finished job by session id so it can be read or followed up. "held" means another live
 * process has it loaded. Unfinished jobs are left to recovery, which counts attempts.
 */
export function claimStored(id: string): JobRecord | "held" | "pending" | undefined {
  const row = byId(id);
  if (!row || owns(row.key)) return undefined;
  if (!tryAcquire(row.key)) return "held";
  const fresh = db().prepare("SELECT finished_at FROM jobs WHERE key = ?").get(row.key) as { finished_at: number | null } | undefined;
  if (!fresh) { releaseOwnership(row.key); return undefined; }
  // Unfinished and unowned: abandoned, waiting for a recovery slot.
  if (fresh.finished_at === null) { releaseOwnership(row.key); return "pending"; }
  db().prepare("UPDATE jobs SET pid = ? WHERE key = ?").run(process.pid, row.key);
  return { key: row.key, options: JSON.parse(row.options) as WorkerOptions, prompt: row.prompt };
}

/** Hand back a claim that will not be used: release the lock and do not count the attempt. */
export function unclaim(key: string): void {
  if (!owns(key)) return;
  db().prepare("UPDATE jobs SET pid = 0, attempts = max(attempts - 1, 0) WHERE key = ?").run(key);
  releaseOwnership(key);
}

/** Let go of a job without deleting it, so another process may load it. */
export function releaseJob(key: string): void {
  if (!owns(key)) return;
  db().prepare("UPDATE jobs SET pid = 0 WHERE key = ?").run(key);
  releaseOwnership(key);
}

/** Finished jobs nobody has loaded, newest first, for listing without opening their stores. */
export function storedJobs(): { sessionId: string; label: string | undefined; finishedAt: string }[] {
  const rows = db().prepare("SELECT key, options, finished_at FROM jobs WHERE agent_dir = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC")
    .all(AGENT_DIR) as { key: string; options: string; finished_at: number }[];
  return rows.filter((row) => !owns(row.key)).map((row) => {
    const options = JSON.parse(row.options) as WorkerOptions;
    return { sessionId: options.id ?? row.key, label: options.label, finishedAt: new Date(row.finished_at).toISOString() };
  });
}

/** Bytes of all job stores. The catalog is not counted. */
export function storageBytes(): number {
  db();
  return readdirSync(JOBS_DIR).reduce((sum, key) => sum + bytes(join(JOBS_DIR, key)), 0);
}

const bytes = (dir: string): number => {
  try { return readdirSync(dir).reduce((sum, file) => sum + statSync(join(dir, file)).size, 0); }
  catch { return 0; }
};

/**
 * Delete finished jobs past retention, then the oldest finished jobs while the store is over its
 * size limit. Unfinished jobs are never deleted, and neither are jobs a live process has loaded:
 * the lock is taken before deleting, as forget does. Returns the deleted keys.
 */
export function sweep(now = Date.now()): string[] {
  const removed: string[] = [];
  const catalog = db();
  const exists = catalog.prepare("SELECT 1 FROM jobs WHERE key = ?");
  // Reclaim interrupted deletes before measuring pressure, so orphan bytes cannot evict
  // otherwise retainable history. A new job holds its lock before creating its directory.
  for (const key of readdirSync(JOBS_DIR)) {
    if (!KEY.test(key) || exists.get(key) !== undefined || owns(key) || !tryAcquire(key)) continue;
    try {
      if (exists.get(key) === undefined) {
        rmSync(jobDir(key), { recursive: true, force: true });
        removed.push(key);
      }
    } finally { releaseOwnership(key); }
  }
  let total = readdirSync(JOBS_DIR).reduce((sum, key) => sum + bytes(join(JOBS_DIR, key)), 0);
  // Each job keeps its own retention. Under size pressure the oldest finished go first whatever
  // their retention, so one long-kept job cannot hold storage above the limit.
  const finished = catalog.prepare(
    "SELECT key, finished_at, coalesce(json_extract(options, '$.retentionDays'), ?) AS days FROM jobs " +
    "WHERE finished_at IS NOT NULL ORDER BY finished_at",
  ).all(RETENTION_DAYS) as { key: string; finished_at: number; days: number }[];
  for (const row of finished) {
    if (row.finished_at + row.days * DAY_MS >= now && total <= STORAGE_LIMIT_BYTES) continue;
    if (owns(row.key) || !tryAcquire(row.key)) continue;
    // Another process may have followed it up, or finished it again, since the scan.
    const fresh = catalog.prepare("SELECT finished_at FROM jobs WHERE key = ?").get(row.key) as { finished_at: number | null } | undefined;
    if (!fresh || fresh.finished_at !== row.finished_at) { releaseOwnership(row.key); continue; }
    const size = bytes(jobDir(row.key));
    forgetOwnedJob(row.key);
    total -= size;
    removed.push(row.key);
  }
  removeTombstones((key) => exists.get(key) !== undefined);
  return removed;
}

/** Removes the row first, then the data, and releases the lock last. The lock file stays. */
export function forgetOwnedJob(key: string): void {
  if (!owns(key)) return;
  db().prepare("DELETE FROM jobs WHERE key = ?").run(key);
  rmSync(jobDir(key), { recursive: true, force: true });
  releaseOwnership(key);
}

export class DurableJob implements JobStore {
  private harness!: Harness;
  private taskId: TaskId<Checkpoint> | undefined;
  private runtime: TaskRuntime<Input, Checkpoint, Checkpoint, object> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private closing = false;
  private execute: Execute | undefined;
  /** Turn count at the first save after a recovery claim; one more turn clears `attempts`. */
  private progressFrom: number | undefined;
  private attemptsPending = false;
  readonly key: string;
  needsResume = false;
  private constructor(key: string) { this.key = key; }

  static async open(options: WorkerOptions, prompt: string, key?: string): Promise<DurableJob> {
    const job = new DurableJob(key ?? randomUUID());
    const catalog = db(); // also initialises the ownership directory
    let attempts = 0;
    let unfinished = false;
    if (!key) {
      if (!uniqueIds) {
        // Retry the index, in case the duplicates were forgotten since this process opened the catalog.
        try {
          catalog.exec("CREATE UNIQUE INDEX IF NOT EXISTS jobs_session ON jobs (agent_dir, json_extract(options, '$.id'))");
          uniqueIds = true;
        } catch {
          throw new Error("The durable catalog holds duplicate session ids, so new durable delegates are refused. " +
            "Use sessions to find them and forget the duplicates, or use durable: false.");
        }
      }
      if (!tryAcquire(job.key)) throw new Error(`Ownership lock for new job ${job.key} is already held`);
    } else if (!owns(key)) {
      throw new Error(`Durable job ${key} is not owned by this process`);
    } else {
      const row = catalog.prepare("SELECT attempts, finished_at FROM jobs WHERE key = ?").get(key) as { attempts: number; finished_at: number | null } | undefined;
      attempts = row?.attempts ?? 0;
      unfinished = row?.finished_at === null;
    }
    job.attemptsPending = attempts > 0;
    const directory = jobDir(job.key);
    const Task = defineTask<Input, Checkpoint, Checkpoint>({
      name: "pi-delegate.sdk", version: 1,
      initial: (input) => input.checkpoint,
      phases: { execute: async (task, runtime, ctx) => {
        job.runtime = runtime;
        try {
          const result = await job.execute!(task.input.prompt, task.state.checkpoint, runtime.signal);
          await job.writes;
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), ctx);
        } finally { job.runtime = undefined; }
      } },
      abort: async (_task, runtime, ctx) => {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
      },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "pi-delegate", tasks: [Task] }));
    try {
      if (!key) catalog.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt) VALUES (?, ?, ?, ?, ?)")
        .run(job.key, process.pid, AGENT_DIR, JSON.stringify(options), prompt);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Pi Durable pins its own pi-ai, while the SDK runtime comes from the global Pi install, whose
      // pi-ai may be newer (1.0.2 brands TranscriptContext). The types then differ, not the runtime:
      // this Harness only stores our task's checkpoints and never runs its own model generations.
      const models = (await getRuntime()) as unknown as HarnessOptions["models"];
      job.harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")),
        { models, registry }, context);
      chmodSync(join(directory, "session.sqlite"), 0o600);
      job.taskId = await job.harness.commit(async (tx) => {
        const current = await tx.doc(CurrentTask);
        if (current.taskId === null) {
          // Migrate stores created before the current-task pointer existed. Their
          // ordered scan is oldest first, so walk all pages once to find the latest.
          let cursor: Cursor | undefined;
          do {
            const page = await tx.scanTasks({ kind: "pi-delegate.sdk" }, 100, cursor);
            if (page.items.length) current.taskId = page.items.at(-1)!.id;
            cursor = page.next;
          } while (cursor);
        }
        return current.taskId === null ? undefined : current.taskId as TaskId<Checkpoint>;
      }, context);
      const current = job.taskId ? await job.harness.getTask(job.taskId, context) : undefined;
      job.needsResume = Boolean(current && current.state.status !== "terminal");
      if (key && !job.needsResume && (job.attemptsPending || unfinished)) {
        // Loading finished history is not a recovery attempt. A crash after the terminal commit but
        // before recordFinal leaves the row unfinished; the worker records it once loaded.
        job.attemptsPending = false;
        catalog.prepare("UPDATE jobs SET attempts = 0 WHERE key = ?").run(key);
      }
      // Judged only here, where the task is known to be unfinished, so finished history is never
      // reported as exhausted. The caller keeps the lock, so no other host retries it either.
      if (job.needsResume && attempts > MAX_RECOVERY_ATTEMPTS)
        throw new Error(`Recovery stopped: the job was claimed ${attempts} times without completing a turn. ` +
          "Inspect it, then forget it.");
      job.task = Task;
      return job;
    } catch (error) {
      await job.harness?.close(context);
      if (!key) forgetOwnedJob(job.key);
      if (!key && /UNIQUE constraint failed/.test(String(error)))
        throw new Error(`Session id "${options.id}" is already in use. Pick another or call abort/forget first.`);
      throw error;
    }
  }
  private task!: ReturnType<typeof defineTask<Input, Checkpoint, Checkpoint>>;

  async saved(): Promise<Checkpoint | undefined> {
    if (!this.taskId) return undefined;
    const task = await this.harness.getTask(this.taskId, context);
    if (task?.state.status === "terminal" || task?.state.status === "completing") {
      if (task.state.outcome.status === "completed") return task.state.outcome.result;
      throw new Error(`Durable task ended with ${task.state.outcome.status}`);
    }
    return task && "checkpoint" in task.state ? task.state.checkpoint as unknown as Checkpoint : undefined;
  }

  async begin(prompt: string, checkpoint: Checkpoint, execute: Execute, recover = false): Promise<{ done: Promise<Checkpoint> }> {
    this.execute = execute;
    if (!recover || !this.taskId) {
      // Unfinished first: a crash before the task commits leaves an unfinished row whose current
      // task is terminal, which recovery reopens and marks finished again. The reverse order would
      // leave a running task marked finished, skipped by recovery and open to the sweep.
      db().prepare("UPDATE jobs SET finished_at = NULL, snapshot = NULL WHERE key = ?").run(this.key);
      const root = await this.harness.root(context);
      this.taskId = await root.commit(async (tx) => {
        const id = await tx.createTask(this.task, { prompt, checkpoint }, { ownership: { kind: "conversation" } });
        (await tx.doc(CurrentTask)).taskId = id;
        return id;
      }, context);
    }
    return { done: this.wait() };
  }
  private async wait(): Promise<Checkpoint> {
    const task = await this.harness.waitForTask(this.taskId!, context);
    if (task.state.outcome.status !== "completed") throw new Error(`Durable task ${task.state.outcome.status}: ` +
      ("error" in task.state.outcome ? JSON.stringify(task.state.outcome.error) : "no result"));
    return task.state.outcome.result;
  }
  /**
   * Mark the job finished together with its final state, in one statement. Until this runs the
   * row stays unfinished, so a crash after the terminal commit is repaired by recovery instead of
   * leaving a finished row with a previous run's snapshot.
   */
  recordFinal(snapshot: Snapshot): void {
    if (!owns(this.key)) return;
    const at = Date.parse(snapshot.finishedAt ?? "") || Date.now();
    db().prepare("UPDATE jobs SET finished_at = ?, snapshot = ? WHERE key = ?").run(at, JSON.stringify(snapshot), this.key);
  }
  save(checkpoint: Checkpoint): Promise<void> {
    if (this.closing || !this.runtime) return Promise.resolve();
    const runtime = this.runtime;
    const copy = JSON.parse(JSON.stringify(checkpoint)) as Checkpoint;
    if (this.attemptsPending) {
      this.progressFrom ??= copy.snapshot.turns;
      if (copy.snapshot.turns > this.progressFrom) {
        this.attemptsPending = false;
        db().prepare("UPDATE jobs SET attempts = 0 WHERE key = ?").run(this.key);
      }
    }
    this.writes = this.writes.then(() => runtime.commit(() => ({ status: "running", checkpoint: copy }), context));
    return this.writes;
  }
  async close(release = true): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.writes.catch(() => {});
    await this.harness.close(context);
    if (release && owns(this.key)) {
      // A clean release is not a crash; the next claim starts counting again.
      db().prepare("UPDATE jobs SET pid = 0, attempts = 0 WHERE key = ?").run(this.key);
      releaseOwnership(this.key);
    }
  }
  async forget(): Promise<void> {
    await this.close(false);
    forgetOwnedJob(this.key);
  }
}
