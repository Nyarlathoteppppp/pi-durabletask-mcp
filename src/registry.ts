import {
  DEFAULT_MODEL,
  HISTORY_LIMIT,
  MAX_CONCURRENT,
  SPAWN_DEFAULT_DURATION_MS,
  SPAWN_DEFAULT_TURNS,
} from "./config.js";
import { pickTools } from "./permissions.js";
import { PiWorker } from "./pi/worker.js";
import { resolveDelegateCwd } from "./workspace.js";
import type { PiThinkingLevel, TerminationReason } from "./types.js";
import { publish } from "./statusline/state.js";
import { claimAbandoned } from "./durable.js";
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
  if (sessions.has(id))
    throw new Error(`Session id "${id}" is already in use. Pick another or call abort/forget first.`);
  return id;
}

export function must(id: string): PiWorker {
  const w = sessions.get(id);
  if (!w) throw new Error(`Unknown sessionId: ${id}`);
  return w;
}

export async function forget(id: string): Promise<void> {
  const worker = sessions.get(id);
  sessions.delete(id);
  await worker?.forgetPersistent();
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
          pickTools(record.options.tools);
          await resolveDelegateCwd(record.options.cwd);
          await PiWorker.recover(record.options, record.prompt, record.key, worker);
          void worker.run?.then(() => { evictHistory(); setImmediate(() => void recoverAbandoned()); });
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

/** Drop the oldest finished sessions once history is over budget. Running ones are safe. */
export function evictHistory(): void {
  const done = all().filter((w) => !w.isActive).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  while (sessions.size > HISTORY_LIMIT && done.length) {
    const oldest = done.shift();
    if (!oldest) break;
    oldest.dispose();
    void forget(oldest.id).catch((error) => process.stderr.write(`[pi-delegate] forget failed: ${String(error)}\n`));
  }
}

export interface LaunchRequest extends NativeMcpOptions {
  prompt: string;
  model?: string | undefined;
  thinking?: PiThinkingLevel | undefined;
  cwd?: string | undefined;
  tools?: string[] | undefined;
  extensions?: boolean | undefined;
  id?: string | undefined;
  label?: string | undefined;
  maxTurns?: number | undefined;
  maxDurationMs?: number | undefined;
}

async function prepare(req: LaunchRequest): Promise<LaunchRequest & { cwd: string; tools: string[] }> {
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
    nativeMcp: req.nativeMcp ?? false,
    mcpServers: req.mcpServers,
    maxTurns: req.maxTurns ?? SPAWN_DEFAULT_TURNS,
    maxDurationMs: req.maxDurationMs ?? SPAWN_DEFAULT_DURATION_MS,
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
  void worker.run?.then(() => setImmediate(() => void recoverAbandoned()));
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
