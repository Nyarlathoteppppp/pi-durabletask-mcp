import {
  DAY_MS,
  DEFAULT_MODEL,
  HISTORY_LIMIT,
  MAX_CONCURRENT,
  SPAWN_DEFAULT_DURATION_MS,
  SPAWN_DEFAULT_TURNS,
} from "./config.js";
import { pickTools } from "./permissions.js";
import { PiWorker, type WorkerOptions } from "./pi/worker.js";
import { resolveDelegateCwd } from "./workspace.js";
import type { PiThinkingLevel, TerminationReason } from "./types.js";
import { publish } from "./statusline/state.js";
import { claimAbandoned, claimStored, forgetOwnedJob, releaseJob, storedIdInUse, sweep } from "./durable.js";
import { validateNativeMcp, type NativeMcpOptions } from "./pi/native-mcp.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Live and finished delegates, newest last. Finished ones stay readable until evicted. */
const sessions = new Map<string, PiWorker>();
let shuttingDown = false;

export const all = (): PiWorker[] => [...sessions.values()];
export const count = (): number => sessions.size;
export const activeCount = (): number =>
  all().filter((worker) => worker.isActive).length;

export function assertCapacity(additional = 1): void {
  if (shuttingDown) throw new Error("MCP server is shutting down; reconnect before starting work.");
  const active = activeCount();
  if (active + additional > MAX_CONCURRENT)
    throw new Error(
      `Delegate concurrency limit is ${MAX_CONCURRENT}; ${active} session(s) are active and ` +
        `${additional} more were requested. Wait, abort a session, or raise PI_DELEGATE_MAX_CONCURRENT.`,
    );
}

/**
 * Validate a caller-supplied id and reserve nothing. Split out from `launch` so a batch
 * can check every id before starting any delegate.
 */
export function claimId(id?: string): string | undefined {
  if (id === undefined) return undefined;
  if (!ID_PATTERN.test(id))
    throw new Error(
      `Invalid id "${id}". Use 1-64 chars: letters, digits, then . _ : - are allowed. ` +
        `Something like "search-audit-01" or "review:engine.go".`,
    );
  if (sessions.has(id) || storedIdInUse(id))
    throw new Error(`Session id "${id}" is already in use. Pick another or call abort/forget first.`);
  return id;
}

const loading = new Map<string, Promise<PiWorker>>();
/** Sessions being unloaded still hold their lock; a lookup waits for it before loading again. */
const unloading = new Map<string, Promise<void>>();
function unload(worker: PiWorker): Promise<void> {
  sessions.delete(worker.id);
  lastUsed.delete(worker.id);
  const done = worker.unload().catch((error: unknown) => { process.stderr.write(`[pi-delegate] unload failed: ${String(error)}\n`); })
    .finally(() => unloading.delete(worker.id));
  unloading.set(worker.id, done);
  return done;
}
/** Stored options must still pass this process's policy before they run again. */
async function checkStoredPolicy(options: WorkerOptions): Promise<void> {
  pickTools(options.tools);
  await resolveDelegateCwd(options.cwd);
}

/** Last lookup or creation per session; history eviction drops the least recently used. */
const lastUsed = new Map<string, number>();
const touch = (id: string): void => { lastUsed.set(id, Date.now()); };

/** A delegate loaded in this process, if any, without loading anything. */
export const loaded = (id: string): PiWorker | undefined => sessions.get(id);

/** A live delegate, or a finished durable one loaded from disk on first use. */
export async function resolve(id: string): Promise<PiWorker> {
  await unloading.get(id);
  const live = sessions.get(id) ?? await loading.get(id);
  if (live) { touch(live.id); return live; }
  const record = claimStored(id);
  if (record === "held")
    throw new Error(`Session ${id} is loaded by another running MCP process. Use it from there, or stop that process.`);
  if (!record) throw new Error(`Unknown sessionId: ${id}`);
  const load = (async () => {
    const worker = new PiWorker(record.options);
    worker.recoveryKey = record.key;
    worker.onChange = () => publish(all());
    try {
      await checkStoredPolicy(record.options);
      await PiWorker.recover(record.options, record.prompt, record.key, worker);
    } catch (error) { worker.dispose(); releaseJob(record.key); throw error; }
    sessions.set(worker.id, worker);
    touch(worker.id);
    evictHistory(worker);
    publish(all());
    return worker;
  })().finally(() => loading.delete(id));
  loading.set(id, load);
  return load;
}

export async function forget(id: string): Promise<void> {
  await unloading.get(id);
  const worker = sessions.get(id);
  if (!worker) {
    // Deleting a stored job does not need its conversation loaded.
    const record = claimStored(id);
    if (record === "held") throw new Error(`Session ${id} is loaded by another running MCP process.`);
    if (!record) throw new Error(`Unknown sessionId: ${id}`);
    forgetOwnedJob(record.key);
    return;
  }
  sessions.delete(id);
  await worker.forgetPersistent();
}

let lastSweep = 0;
/**
 * Apply retention. Runs at startup and when delegates finish, at most once a minute. Finished
 * delegates past retention are unloaded first, so the sweep can delete them.
 */
export function sweepStorage(force = false): void {
  const now = Date.now();
  if (!force && now - lastSweep < 60_000) return;
  lastSweep = now;
  const expired = all().filter((w) => w.retentionDays !== undefined && !w.isActive && w.finishedAt &&
    Date.parse(w.finishedAt) + w.retentionDays * DAY_MS < now);
  void Promise.all(expired.map(unload))
    .then(() => sweep(now))
    .catch((error) => process.stderr.write(`[pi-delegate] storage sweep failed: ${String(error)}\n`))
    .finally(() => publish(all()));
}

let recovering: Promise<void> | undefined;
/** Called by init and when work settles; only abandoned stores can change owners. */
export async function recoverAbandoned(): Promise<void> {
  if (shuttingDown) return;
  if (recovering) return recovering;
  recovering = (async () => {
    while (!shuttingDown && activeCount() < MAX_CONCURRENT) {
      const records = claimAbandoned(new Set(sessions.keys()), Math.max(0, MAX_CONCURRENT - activeCount()));
      if (!records.length) break;
      // Reserve the entire claim before awaiting model/runtime initialization.
      const claimed = records.map((record) => {
        const worker = new PiWorker(record.options);
        worker.recoveryKey = record.key;
        sessions.set(worker.id, worker);
        worker.onChange = () => publish(all());
        return { record, worker };
      });
      for (const { record, worker } of claimed) {
        try {
          await checkStoredPolicy(record.options);
          await PiWorker.recover(record.options, record.prompt, record.key, worker);
          void worker.run?.then(() => { evictHistory(); sweepStorage(); setImmediate(() => void recoverAbandoned()); });
        } catch (error) {
          worker.state = "error";
          worker.error = `Recovery failed: ${String(error)}`;
          worker.finishedAt = new Date().toISOString();
          process.stderr.write(`[pi-delegate] recovery failed for ${record.options.id}: ${String(error)}\n`);
        }
      }
    }
    evictHistory();
    publish(all());
    sweepStorage(true);
  })().finally(() => { recovering = undefined; });
  return recovering;
}

export async function suspendAll(): Promise<void> {
  shuttingDown = true;
  await Promise.all(all().map((worker) => worker.suspend()));
}

/** Stop every live delegate before the MCP server exits. */
export async function abortAll(reason: TerminationReason = "server_shutdown"): Promise<void> {
  await Promise.all(
    all()
      .filter((worker) => worker.isActive)
      .map((worker) => worker.abort(reason)),
  );
}

/**
 * Unload the oldest finished sessions once in-memory history is over budget. Running ones are safe.
 * This only frees memory: durable sessions stay on disk, loadable by id, until retention removes them.
 */
export function evictHistory(keep?: PiWorker): void {
  const used = (w: PiWorker): number => lastUsed.get(w.id) ?? Date.parse(w.startedAt);
  const done = all().filter((w) => !w.isActive && w !== keep).sort((a, b) => used(a) - used(b));
  while (sessions.size > HISTORY_LIMIT && done.length) {
    const oldest = done.shift();
    if (!oldest) break;
    void unload(oldest);
  }
}

export interface LaunchRequest extends NativeMcpOptions {
  prompt: string;
  model?: string | undefined;
  thinking?: PiThinkingLevel | undefined;
  cwd?: string | undefined;
  tools?: string[] | undefined;
  extensions?: boolean | undefined;
  durable?: boolean | undefined;
  id?: string | undefined;
  label?: string | undefined;
  maxTurns?: number | undefined;
  maxDurationMs?: number | undefined;
  retentionDays?: number | undefined;
}

async function prepare(req: LaunchRequest): Promise<LaunchRequest & { cwd: string; tools: string[] }> {
  if (req.retentionDays !== undefined && req.durable !== true)
    throw new Error("retentionDays applies only to durable delegates; pass durable: true as well.");
  const cwd = await resolveDelegateCwd(req.cwd);
  validateNativeMcp(req, cwd);
  return { ...req, cwd, tools: pickTools(req.tools) };
}

function makeWorker(req: LaunchRequest & { cwd: string; tools: string[] }): PiWorker {
  return new PiWorker({
    id: claimId(req.id),
    label: req.label,
    cwd: req.cwd,
    model: req.model || DEFAULT_MODEL,
    thinking: req.thinking,
    tools: req.tools,
    extensions: req.extensions ?? false,
    durable: req.durable ?? false,
    nativeMcp: req.nativeMcp ?? false,
    mcpServers: req.mcpServers,
    maxTurns: req.maxTurns ?? SPAWN_DEFAULT_TURNS,
    maxDurationMs: req.maxDurationMs ?? SPAWN_DEFAULT_DURATION_MS,
    retentionDays: req.retentionDays,
  });
}

async function startWorker(worker: PiWorker, prompt: string): Promise<PiWorker> {
  try {
    await worker.start(prompt);
  } catch (e) {
    // A session that never started must not occupy its id.
    worker.dispose();
    sessions.delete(worker.id);
    await worker.forgetPersistent();
    publish(all());
    throw e;
  }
  evictHistory();
  void worker.run?.then(() => { sweepStorage(); setImmediate(() => void recoverAbandoned()); });
  publish(all());
  return worker;
}

/** Reserve capacity and identity together, with no await between checking and insertion. */
export async function launch(req: LaunchRequest): Promise<PiWorker> {
  const prepared = await prepare(req);
  assertCapacity();
  const worker = makeWorker(prepared);
  worker.onChange = () => publish(all());
  sessions.set(worker.id, worker);
  return startWorker(worker, req.prompt);
}

/** Reserve the entire batch before starting any worker or allowing another request to interleave. */
export async function launchBatch(reqs: LaunchRequest[]): Promise<PromiseSettledResult<PiWorker>[]> {
  const prepared = await Promise.all(reqs.map(prepare));
  assertCapacity(prepared.length);
  const seen = new Set<string>();
  for (const req of prepared) {
    if (req.id !== undefined) {
      claimId(req.id);
      if (seen.has(req.id)) throw new Error(`Batch reuses session id "${req.id}".`);
      seen.add(req.id);
    }
  }
  const workers = prepared.map(makeWorker);
  for (const worker of workers) {
    worker.onChange = () => publish(all());
    sessions.set(worker.id, worker);
  }
  return Promise.allSettled(workers.map((worker, i) => startWorker(worker, prepared[i]!.prompt)));
}
