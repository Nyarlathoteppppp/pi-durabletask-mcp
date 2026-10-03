import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry, defineDoc, defineExtension, defineTask, Harness,
  type Cursor, type TaskId, type TaskRuntime,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, STATE_DIR } from "./config.js";
import { getRuntime } from "./pi/runtime.js";
import type { WorkerOptions } from "./pi/worker.js";
import type { Snapshot } from "./types.js";

export const DURABLE_DIR = join(STATE_DIR, "durable");
const context = BACKGROUND_CONTEXT;

export interface Checkpoint {
  phase: "execute";
  entries: FileEntry[];
  snapshot: Snapshot;
  inputStarted: boolean;
  results: Record<string, { content: unknown; details?: unknown; isError: boolean; name: string }>;
  steering: string[];
  recoveryInput?: { text: string; steeringCount: number };
}
const CurrentTask = defineDoc<{ taskId: number | null }>({
  kind: "pi-delegate.current-task", version: 1, scope: "session", initial: () => ({ taskId: null }),
});
interface Input { prompt: string; checkpoint: Checkpoint }
export interface JobRecord { key: string; options: WorkerOptions; prompt: string }
type Row = { key: string; pid: number; options: string; prompt: string };
type Execute = (prompt: string, saved: Checkpoint, signal: AbortSignal) => Promise<Checkpoint>;

let catalog: DatabaseSync | undefined;
function db(): DatabaseSync {
  if (catalog) return catalog;
  mkdirSync(DURABLE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(DURABLE_DIR, 0o700);
  catalog = new DatabaseSync(join(DURABLE_DIR, "catalog.sqlite"));
  catalog.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, pid INTEGER NOT NULL,
      agent_dir TEXT NOT NULL, options TEXT NOT NULL, prompt TEXT NOT NULL);`);
  chmodSync(join(DURABLE_DIR, "catalog.sqlite"), 0o600);
  return catalog;
}
function alive(pid: number): boolean {
  if (pid === 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** SQLite's conditional update selects one owner even when multiple MCP hosts recover together. */
export function claimAbandoned(excludeIds: Set<string>, limit: number): JobRecord[] {
  const records: JobRecord[] = [];
  for (const row of db().prepare("SELECT * FROM jobs WHERE agent_dir = ? ORDER BY rowid DESC").all(AGENT_DIR) as Row[]) {
    if (records.length >= limit) break;
    if (alive(row.pid)) continue;
    const options = JSON.parse(row.options) as WorkerOptions;
    if (options.id && excludeIds.has(options.id)) continue;
    const changed = db().prepare("UPDATE jobs SET pid = ? WHERE key = ? AND pid = ?")
      .run(process.pid, row.key, row.pid).changes;
    if (changed) {
      records.push({ key: row.key, options, prompt: row.prompt });
      if (options.id) excludeIds.add(options.id);
    }
  }
  return records;
}

export function forgetOwnedJob(key: string): void {
  const removed = db().prepare("DELETE FROM jobs WHERE key = ? AND pid = ?").run(key, process.pid).changes;
  if (removed) rmSync(join(DURABLE_DIR, key), { recursive: true, force: true });
}

export class DurableJob {
  private harness!: Harness;
  private taskId: TaskId<Checkpoint> | undefined;
  private runtime: TaskRuntime<Input, Checkpoint, Checkpoint, object> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private closing = false;
  private execute: Execute | undefined;
  readonly key: string;
  needsResume = false;
  private constructor(key: string) { this.key = key; }

  static async open(options: WorkerOptions, prompt: string, key?: string): Promise<DurableJob> {
    const job = new DurableJob(key ?? randomUUID());
    if (!key) db().prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?)")
      .run(job.key, process.pid, AGENT_DIR, JSON.stringify(options), prompt);
    const directory = join(DURABLE_DIR, job.key);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
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
      job.harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")),
        { models: await getRuntime(), registry }, context);
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
      job.task = Task;
      return job;
    } catch (error) {
      await job.harness?.close(context);
      if (!key) forgetOwnedJob(job.key);
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
  save(checkpoint: Checkpoint): Promise<void> {
    if (this.closing || !this.runtime) return Promise.resolve();
    const runtime = this.runtime;
    const copy = JSON.parse(JSON.stringify(checkpoint)) as Checkpoint;
    this.writes = this.writes.then(() => runtime.commit(() => ({ status: "running", checkpoint: copy }), context));
    return this.writes;
  }
  async close(release = true): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.writes.catch(() => {});
    await this.harness.close(context);
    if (release) db().prepare("UPDATE jobs SET pid = 0 WHERE key = ? AND pid = ?").run(this.key, process.pid);
  }
  async forget(): Promise<void> {
    await this.close(false);
    forgetOwnedJob(this.key);
  }
}
