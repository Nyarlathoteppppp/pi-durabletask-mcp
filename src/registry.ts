import {
  DAY_MS,
  RECOVERY_INTERVAL_MS,
  DEFAULT_MODEL,
  RETENTION_DAYS,
  STORAGE_LIMIT_BYTES,
  HISTORY_LIMIT,
  MAX_CONCURRENT,
  SPAWN_DEFAULT_DURATION_MS,
  SPAWN_DEFAULT_TURNS,
} from "./config.js";
import { pickTools } from "./permissions.js";
import { PiWorker, type WorkerOptions } from "./pi/worker.js";
import { resolveDelegateCwd } from "./workspace.js";
import type { PiThinkingLevel, TerminationReason, Usage } from "./types.js";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { publish } from "./statusline/state.js";
import { claimAbandonedSettled, claimStored, jitter, unclaim, forgetOwnedJob, RecoveryStopped, storageBytes, storedIdInUse, sweep } from "./durable.js";
import { validateNativeMcp, type NativeMcpOptions } from "./pi/native-mcp.js";
import { checkSavePath, saveDirPath } from "./save.js";

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

/** Say why a session cannot be used here, so a caller does not retry a missing or busy id blindly. */
function unavailable(id: string, reason: "held" | "pending" | undefined): Error {
  if (reason === "held")
    return new Error(`Session ${id} is running or loaded in another MCP process. status and wait read it here ` +
      "once it has finished; to steer, follow up or forget it, use that process or stop it.");
  if (reason === "pending")
    return new Error(`Session ${id} is unfinished and waiting for recovery; a process resumes it when a ` +
      "delegate slot is free. Check again shortly.");
  return new Error(`Unknown sessionId: ${id}. Sessions without durable: true end with the MCP process that ran ` +
    "them, or earlier once finished when PI_DELEGATE_HISTORY (default 50) newer ones push them out; durable ones " +
    "end at forget or after retention. sessions lists what exists here.");
}

/** A live delegate, or a finished durable one loaded from disk on first use. */
export async function resolve(id: string): Promise<PiWorker> {
  // Await only an unload or load in flight. Any other await before claimStored lets eviction or
  // another lookup start meanwhile; claimStored then finds this process owning the job and the
  // session is reported unknown.
  const unloadingNow = unloading.get(id);
  if (unloadingNow) await unloadingNow;
  const inFlight = loading.get(id);
  const live = sessions.get(id) ?? (inFlight && await inFlight);
  if (live) { touch(live.id); return live; }
  let record = claimStored(id);
  if (record === "held") {
    // Another process loading the same session at the same instant can make both back off.
    await jitter();
    const loadNow = loading.get(id);
    const now = sessions.get(id) ?? (loadNow && await loadNow);
    if (now) { touch(now.id); return now; }
    record = claimStored(id);
  }
  if (record === "pending") void recoverAbandoned(); // someone is waiting for it: try now
  if (typeof record !== "object") throw unavailable(id, record);
  const load = (async () => {
    const worker = new PiWorker({ ...record.options, durable: true });
    worker.recoveryKey = record.key;
    worker.onChange = () => publish(all());
    try {
      await checkStoredPolicy(record.options);
      await PiWorker.recover({ ...record.options, durable: true }, record.prompt, record.key, worker);
    } catch (error) {
      try {
        await worker.releaseRecovery();
      } catch (cleanupError) {
        worker.state = "error";
        worker.error = `Recovery failed: ${String(error)}; recovery cleanup failed: ${String(cleanupError)}`;
        worker.finishedAt = new Date().toISOString();
        sessions.set(worker.id, worker);
        publish(all());
      }
      throw error;
    }
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
  // As in resolve: no await before claimStored except for an unload or load in flight.
  const unloadingNow = unloading.get(id);
  if (unloadingNow) await unloadingNow;
  const inFlight = loading.get(id);
  const worker = sessions.get(id) ?? (inFlight && await inFlight);
  if (!worker) {
    // Deleting a stored job does not need its conversation loaded.
    const record = claimStored(id);
    if (typeof record !== "object") throw unavailable(id, record);
    forgetOwnedJob(record.key);
    return;
  }
  // Check and dispose the actual worker, including one obtained after awaiting a lazy load.
  if (worker.isActive)
    throw new Error(`Session ${id} is still ${worker.state}. Call abort first.`);
  worker.dispose();
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
  // Over the size limit, every finished durable session here is unloaded too, so the sweep can
  // delete the oldest; unloaded ones stay readable and reload on follow_up if they survive.
  const over = storageBytes() > STORAGE_LIMIT_BYTES;
  const expired = all().filter((w) => !w.recoveryCleanupFailed && w.retentionDays !== undefined && !w.isActive && w.finishedAt &&
    (over || Date.parse(w.finishedAt) + w.retentionDays * DAY_MS < now));
  void Promise.all(expired.map(unload))
    .then(() => sweep(now))
    .catch((error) => process.stderr.write(`[pi-delegate] storage sweep failed: ${String(error)}\n`))
    .finally(() => publish(all()));
}

let recovering: Promise<void> | undefined;
/** Called at server startup and when work settles; only abandoned stores can change owners. */
export async function recoverAbandoned(): Promise<void> {
  if (shuttingDown) return;
  if (recovering) return recovering;
  recovering = (async () => {
    // Failed this round: retried on a later tick, not at once, so a passing failure cannot spend
    // every attempt within milliseconds.
    const failed = new Set<string>();
    while (!shuttingDown && activeCount() < MAX_CONCURRENT) {
      // A budget read at each claim attempt, so a retry after waiting sees current capacity and shutdown.
      const records = await claimAbandonedSettled(() => shuttingDown ? undefined
        : { excludeIds: new Set([...sessions.keys(), ...failed]), limit: Math.max(0, MAX_CONCURRENT - activeCount()) });
      if (!records.length) break;
      // Shutdown can begin while the claim's promise settles (in the same task). The claim then
      // goes back unused: suspendAll has already taken its snapshot of the workers.
      if (shuttingDown) { for (const record of records) unclaim(record.key); break; }
      // Reserve the entire claim before awaiting model/runtime initialization.
      const claimed = records.map((record) => {
        const worker = new PiWorker({ ...record.options, durable: true });
        worker.recoveryKey = record.key;
        sessions.set(worker.id, worker);
        worker.onChange = () => publish(all());
        return { record, worker };
      });
      for (const { record, worker } of claimed) {
        try {
          await checkStoredPolicy(record.options);
          await PiWorker.recover({ ...record.options, durable: true }, record.prompt, record.key, worker);
          void worker.run?.then(() => { evictHistory(); sweepStorage(); setImmediate(() => void recoverAbandoned()); });
        } catch (error) {
          process.stderr.write(`[pi-delegate] recovery failed for ${record.options.id}: ${String(error)}\n`);
          if (error instanceof RecoveryStopped) {
            // Past its attempts: keep the lock and show the error, so no process retries it forever.
            worker.state = "error";
            worker.error = `Recovery failed: ${String(error)}`;
            worker.finishedAt = new Date().toISOString();
          } else {
            // Possibly passing (auth, runtime start): clean up the executor while keeping the
            // counted attempt. A cleanup failure keeps the lock and the worker for diagnosis.
            failed.add(worker.id);
            try {
              await worker.releaseRecovery();
              sessions.delete(worker.id);
            } catch (cleanupError) {
              worker.state = "error";
              worker.error = `Recovery failed: ${String(error)}; recovery cleanup failed: ${String(cleanupError)}`;
              worker.finishedAt = new Date().toISOString();
            }
          }
        }
      }
    }
    evictHistory();
    publish(all());
    sweepStorage(true);
  })().finally(() => { recovering = undefined; });
  return recovering;
}

/**
 * Look for abandoned jobs periodically. Startup and local completions are not enough: a job whose
 * owner exits while this process is idle (an old window closed) would otherwise wait for the next
 * restart. A claim attempt is cheap, and a busy lock is skipped without waiting.
 */
export function startRecoveryTicks(): void {
  setInterval(() => void recoverAbandoned(), RECOVERY_INTERVAL_MS).unref();
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
  const done = all().filter((w) => !w.recoveryCleanupFailed && !w.isActive && w !== keep).sort((a, b) => used(a) - used(b));
  while (sessions.size > HISTORY_LIMIT && done.length) {
    const oldest = done.shift();
    if (!oldest) break;
    void unload(oldest);
  }
}

export interface LaunchRequest extends NativeMcpOptions {
  /** Runtime-only tool adapter injected by the core; never persisted with WorkerOptions. */
  createTools?: (worker: PiWorker) => import("@earendil-works/pi-coding-agent").ToolDefinition[];
  prompt: string;
  /** Internal fork data prepared by the execution core, never accepted directly by MCP tools. */
  seedEntries?: FileEntry[];
  forkedFrom?: string;
  usageBaseline?: Usage;
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
  maxToolCalls?: number | undefined;
  /** Write the final text to this file when the run finishes; not persisted with the task. */
  saveTo?: string | undefined;
  /** As saveTo, as <saveDir>/<sessionId>.md, for batches. */
  saveDir?: string | undefined;
}

async function prepare(req: LaunchRequest): Promise<LaunchRequest & { cwd: string; tools: string[] }> {
  if (req.retentionDays !== undefined && req.durable !== true)
    throw new Error("retentionDays applies only to durable delegates; pass durable: true as well.");
  if (req.saveTo !== undefined) checkSavePath(req.saveTo);
  if (req.saveDir !== undefined) checkSavePath(req.saveDir, "saveDir");
  const cwd = await resolveDelegateCwd(req.cwd);
  validateNativeMcp(req, cwd);
  return { ...req, cwd, tools: pickTools(req.tools) };
}

function makeWorker(req: LaunchRequest & { cwd: string; tools: string[] }): PiWorker {
  const worker = new PiWorker({
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
    maxToolCalls: req.maxToolCalls,
    forkedFrom: req.forkedFrom,
    usageBaseline: req.usageBaseline,
    // Fixed at creation, so every process applies the same retention whatever its own default.
    retentionDays: req.durable ? req.retentionDays ?? RETENTION_DAYS : undefined,
  });
  worker.customTools = req.createTools?.(worker) ?? [];
  worker.saveTo = req.saveTo ?? (req.saveDir ? saveDirPath(req.saveDir, worker.id) : undefined);
  return worker;
}

async function startWorker(worker: PiWorker, prompt: string, seedEntries?: FileEntry[]): Promise<PiWorker> {
  try {
    await worker.start(prompt, undefined, undefined, seedEntries);
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
/**
 * onCreated runs once the worker exists and before it starts, so a caller can bind cancellation
 * that also covers start: a worker aborted there never prompts Pi.
 */
export async function launch(req: LaunchRequest, onCreated?: (worker: PiWorker) => void): Promise<PiWorker> {
  const prepared = await prepare(req);
  assertCapacity();
  const worker = makeWorker(prepared);
  worker.onChange = () => publish(all());
  sessions.set(worker.id, worker);
  onCreated?.(worker);
  return startWorker(worker, req.prompt, prepared.seedEntries);
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
  return Promise.allSettled(workers.map((worker, i) => startWorker(worker, prepared[i]!.prompt, prepared[i]!.seedEntries)));
}
