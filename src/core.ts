/** Execution operations shared by protocol adapters. Registry and PiWorker own lifecycle/state. */
import { DEFAULT_MODEL, PROGRESS_MS, RUN_DEFAULT_DURATION_MS, RUN_DEFAULT_TURNS } from "./config.js";
import {
  all, assertCapacity, claimId, evictHistory, forget, launch, launchBatch, loaded, resolve,
} from "./registry.js";
import type { LaunchRequest } from "./registry.js";
import { storedJobs, storedSnapshot } from "./durable.js";
import { compactSnapshot, message } from "./pi/worker.js";
import type { PiWorker } from "./pi/worker.js";
import type { Snapshot } from "./types.js";
import { pickTools } from "./permissions.js";
import { assertThinkingSupported, resolveModel } from "./pi/models.js";
import { resolveDelegateCwd } from "./workspace.js";
import { validateNativeMcp } from "./pi/native-mcp.js";

const TERMINAL = new Set(["done", "aborted", "error"]);

/** Wait without owning the worker lifecycle. Cancelling this wait never aborts the delegate. */
export async function waitForProgress(
  worker: PiWorker,
  timeoutMs: number,
  signal?: AbortSignal,
  afterTurns = worker.turns,
  afterToolCalls = worker.toolCalls.length,
): Promise<Snapshot> {
  if (
    TERMINAL.has(worker.state) ||
    worker.turns > afterTurns ||
    worker.toolCalls.length > afterToolCalls ||
    signal?.aborted
  )
    return worker.snapshot();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve(worker.snapshot());
    };
    const poll = setInterval(() => {
      if (
        TERMINAL.has(worker.state) ||
        worker.turns > afterTurns ||
        worker.toolCalls.length > afterToolCalls
      )
        finish();
    }, 200);
    const timeout = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

/**
 * Reading a finished session needs no ownership: its final state is in the catalog. This keeps
 * sessions loaded by another process readable, and avoids loading a conversation just to look.
 */
function stored(sessionId: string, verbose?: boolean): Snapshot | undefined {
  if (loaded(sessionId)) return undefined;
  const snapshot = storedSnapshot(sessionId);
  return snapshot && (verbose ? snapshot : compactSnapshot(snapshot));
}

export function bindCancellation(
  signal: AbortSignal,
  abort: () => void | Promise<void>,
): () => void {
  const cancel = (): void => {
    void abort();
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

export async function startExecution(request: LaunchRequest) {
  const w = await launch(request);
  return {
    sessionId: w.id,
    label: w.label,
    state: w.state,
    model: w.model,
    thinking: w.thinking,
    activeTools: w.activeTools,
    limits: { maxTurns: w.maxTurns, maxDurationMs: w.maxDurationMs },
  };
}

export interface BatchRequest extends Omit<LaunchRequest, "prompt" | "id" | "label"> {
  tasks: LaunchRequest[];
  idPrefix?: string;
}

export async function startBatch({
  tasks, model, thinking, cwd, tools, extensions, durable, nativeMcp, mcpServers,
  maxTurns, maxDurationMs, retentionDays, idPrefix,
}: BatchRequest) {
  const width = Math.max(String(tasks.length).length, 2);
  const merged = tasks.map((t, i) => ({
    prompt: t.prompt,
    label: t.label,
    model: t.model ?? model,
    thinking: t.thinking ?? thinking,
    cwd: t.cwd ?? cwd,
    tools: t.tools ?? tools,
    extensions: t.extensions ?? extensions,
    durable: t.durable ?? durable,
    nativeMcp: t.nativeMcp ?? nativeMcp,
    mcpServers: t.mcpServers ?? mcpServers,
    maxTurns: t.maxTurns ?? maxTurns,
    maxDurationMs: t.maxDurationMs ?? maxDurationMs,
    retentionDays: t.retentionDays ?? retentionDays,
    id: t.id ?? (idPrefix ? `${idPrefix}-${String(i + 1).padStart(width, "0")}` : undefined),
  }));

  // Validate the batch up front. Every check here is cheap and deterministic, and a
  // half-started fan-out is the worst outcome: you pay for the delegates that launched
  // and still have to work out which ones did not.
  const seen = new Set<string>();
  for (const [i, t] of merged.entries()) {
    if (t.id) {
      if (seen.has(t.id))
        throw new Error(`tasks[${i}] reuses id "${t.id}" from earlier in the same batch. Ids must be unique.`);
      seen.add(t.id);
      claimId(t.id);
    }
    try {
      pickTools(t.tools);
      const taskCwd = await resolveDelegateCwd(t.cwd ?? cwd);
      validateNativeMcp(t, taskCwd);
      const taskModel = await resolveModel(t.model || DEFAULT_MODEL, taskCwd);
      assertThinkingSupported(taskModel, t.thinking);
    } catch (e) {
      throw new Error(`tasks[${i}]${t.id ? ` (${t.id})` : ""}: ${message(e)}`);
    }
  }

  const started: Array<{
    index: number;
    sessionId: string;
    label?: string;
    state: string;
    model?: string;
    thinking?: string;
    limits: { maxTurns: number; maxDurationMs: number };
  }> = [];
  const failures: Array<{ index: number; id?: string; error: string }> = [];
  const results = await launchBatch(merged);
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const w = result.value;
      started.push({
        index,
        sessionId: w.id,
        label: w.label,
        state: w.state,
        model: w.model,
        thinking: w.thinking,
        limits: { maxTurns: w.maxTurns, maxDurationMs: w.maxDurationMs },
      });
    } else {
      failures.push({ index, id: merged[index]?.id, error: message(result.reason) });
    }
  });
  const byIndex = (a: { index: number }, b: { index: number }) => a.index - b.index;
  started.sort(byIndex);
  failures.sort(byIndex);
  return {
    requested: merged.length,
    started: started.length,
    sessions: started,
    // Only reachable if a session dies during construction, after validation passed.
    ...(failures.length ? { failed: failures.length, failures } : {}),
  };
}

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { state: Snapshot["state"]; turns: number }) => void | Promise<void>;
}

export async function runExecution(
  request: LaunchRequest,
  { signal, onProgress }: RunOptions = {},
): Promise<Snapshot> {
  const w = await launch({
    ...request,
    maxTurns: request.maxTurns ?? RUN_DEFAULT_TURNS,
    maxDurationMs: request.maxDurationMs ?? RUN_DEFAULT_DURATION_MS,
  });
  const unbindCancellation = signal ? bindCancellation(signal, async () => {
    await w.abort("caller_cancelled");
  }) : () => {};
  const ticker = onProgress
    ? setInterval(() => {
        // Progress is observational; both synchronous and async sink failures are ignored.
        void (async () => onProgress({ state: w.state, turns: w.turns }))().catch(() => {});
      }, PROGRESS_MS)
    : undefined;
  try {
    await w.run;
  } finally {
    if (ticker) clearInterval(ticker);
    unbindCancellation();
  }
  const snap = w.snapshot();
  evictHistory();
  return snap;
}

export async function getState(sessionId: string, verbose?: boolean): Promise<Snapshot> {
  return stored(sessionId, verbose) ?? (await resolve(sessionId)).snapshot({ verbose });
}

export interface WaitOptions {
  timeoutMs?: number;
  afterTurns?: number;
  afterToolCalls?: number;
  verbose?: boolean;
  signal?: AbortSignal;
}

export async function waitForState(
  sessionId: string,
  { timeoutMs = 30_000, afterTurns, afterToolCalls, verbose, signal }: WaitOptions = {},
): Promise<Snapshot> {
  // A finished session elsewhere cannot progress; its recorded state is the answer.
  const finished = stored(sessionId, verbose);
  if (finished) return finished;
  const worker = await resolve(sessionId);
  await waitForProgress(
    worker, timeoutMs, signal, afterTurns ?? worker.turns, afterToolCalls ?? worker.toolCalls.length,
  );
  return worker.snapshot({ verbose });
}

export async function steerExecution(sessionId: string, text: string) {
  return (await resolve(sessionId)).steer(text);
}

export async function resolveInteraction(sessionId: string, requestId: string, value: string | boolean) {
  return (await resolve(sessionId)).answer(requestId, value);
}

export async function followUp(sessionId: string, prompt: string) {
  const worker = await resolve(sessionId);
  // Let the worker produce the more useful "use steer" error for a live session.
  if (!worker.isActive) assertCapacity();
  return worker.followUp(prompt);
}

export async function cancelExecution(sessionId: string) {
  return (await resolve(sessionId)).abort();
}

export function listSessions(state?: string, verbose?: boolean) {
  const snaps = all().map((w) => w.snapshot());
  const filtered = state ? snaps.filter((s) => s.state === state) : snaps;
  const list = verbose
    ? filtered
    : filtered.map((s) => ({
        sessionId: s.sessionId,
        label: s.label,
        state: s.state,
        model: s.model,
        thinking: s.thinking,
        turns: s.turns,
        elapsedMs: s.elapsedMs,
        limits: s.limits,
        termination: s.termination,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        pendingQuestions: s.questions.length,
        durable: s.durable,
      }));
  const loaded = new Set(snaps.map((s) => s.sessionId));
  const stored = storedJobs().filter((job) => !loaded.has(job.sessionId));
  return { count: list.length, sessions: list, stored };
}

export async function forgetSession(sessionId: string) {
  const w = all().find((worker) => worker.id === sessionId);
  if (w?.isActive)
    throw new Error(`Session ${sessionId} is still ${w.state}. Call abort first.`);
  w?.dispose();
  await forget(sessionId);
  return { forgotten: sessionId };
}
