/** Execution operations shared by protocol adapters. Registry and PiWorker own lifecycle/state. */
import { PROGRESS_MS, RUN_DEFAULT_DURATION_MS, RUN_DEFAULT_TURNS } from "./config.js";
import {
  all, assertCapacity, claimId, evictHistory, forget, launch, launchBatch, loaded, resolve,
} from "./registry.js";
import type { LaunchRequest } from "./registry.js";
import { storedJobs, storedSnapshot } from "./durable.js";
import { prepareResources } from "./pi/resources.js";
import { message } from "./errors.js";
import { compactSnapshot } from "./pi/snapshot.js";
import { readTextFiles, withAttachments } from "./attachments.js";
import { checkSavePath, omitsSavedText } from "./save.js";
import type { FollowUpBudget } from "./pi/run.js";
import type { PiWorker } from "./pi/worker.js";
import type { Snapshot } from "./types.js";
import type { FollowUpInfo } from "./continuation.js";
import { pickTools } from "./permissions.js";
import { assertProviderReady, assertThinkingSupported, defaultModelRef, resolveModel } from "./pi/models.js";
import { resolveDelegateCwd } from "./workspace.js";
import { validateNativeMcp } from "./pi/native-mcp.js";
import { COORDINATOR_PROMPT, coordinatorSchema, createCoordinatorTools, type CoordinatorOptions } from "./coordinator.js";

const TERMINAL = new Set(["done", "aborted", "error"]);
const hasFinished = (worker: PiWorker): boolean => TERMINAL.has(worker.state) && !worker.isActive;

const observedState = (worker: PiWorker): Snapshot["state"] =>
  TERMINAL.has(worker.state) && worker.isActive ? "running" : worker.state;

/** A timed-out wait must keep the caller waiting while the final result is still committing. */
function waitingSnapshot(worker: PiWorker, verbose?: boolean): Snapshot {
  const snapshot = worker.snapshot({ verbose, diagnostics: verbose });
  snapshot.state = observedState(worker);
  return snapshot;
}

/** Wait without owning the worker lifecycle. Cancelling this wait never aborts the delegate. */
export async function waitForProgress(
  worker: PiWorker,
  timeoutMs: number,
  signal?: AbortSignal,
  afterTurns = worker.turns,
  afterToolCalls = worker.toolCalls.length,
): Promise<Snapshot> {
  if (
    hasFinished(worker) ||
    worker.turns > afterTurns ||
    worker.toolCalls.length > afterToolCalls ||
    worker.questions.size > 0 ||
    signal?.aborted
  )
    return waitingSnapshot(worker);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve(waitingSnapshot(worker));
    };
    const poll = setInterval(() => {
      if (
        hasFinished(worker) ||
        worker.turns > afterTurns ||
        worker.toolCalls.length > afterToolCalls ||
        worker.questions.size > 0
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

/** A launch as a tool receives it: attachments are inlined into the prompt before anything starts. */
export type AttachedRequest = Omit<LaunchRequest, "prompt"> & {
  prompt?: string | undefined;
  attachments?: string[] | undefined; forkFrom?: string | undefined; coordinator?: CoordinatorOptions | undefined;
};
type PreparedRequest = AttachedRequest & { prompt: string };

/** Resolve team defaults before fork inheritance, for every entry point into the core. */
function launchDefaults(request: AttachedRequest): PreparedRequest {
  const prompt = request.prompt ?? (request.coordinator ? COORDINATOR_PROMPT : undefined);
  if (prompt === undefined) throw new Error("prompt is required unless coordinator supplies a task plan.");
  return { ...request, prompt, tools: request.tools ?? (request.coordinator ? ["codemode"] : undefined) };
}

/** Capture once before launching a batch; later parent follow-ups cannot change any seed. */
async function withFork(request: AttachedRequest, seeds = new Map<string, ReturnType<PiWorker["forkSeed"]>>()): Promise<PreparedRequest> {
  const { forkFrom, ...task } = launchDefaults(request);
  if (forkFrom === undefined) return task;
  let seed = seeds.get(forkFrom);
  if (!seed) {
    seed = (await resolve(forkFrom)).forkSeed();
    seeds.set(forkFrom, seed);
  }
  return { ...task,
    cwd: task.cwd ?? seed.inherited.cwd, tools: task.tools ?? seed.inherited.tools,
    model: task.model ?? seed.inherited.model, thinking: task.thinking ?? seed.inherited.thinking,
    extensions: task.extensions ?? seed.inherited.extensions, nativeMcp: task.nativeMcp ?? seed.inherited.nativeMcp,
    mcpServers: task.mcpServers ?? seed.inherited.mcpServers,
    resources: task.resources ?? seed.inherited.resources,
    seedEntries: seed.entries, usageBaseline: seed.usageBaseline, forkedFrom: forkFrom };
}

function withCoordinator({ coordinator, ...request }: PreparedRequest): LaunchRequest {
  if (!coordinator) return request;
  // These closures/membership have no recovery representation. A durable parent would appear
  // resumable after restart while its memory children and dispatch receipts were gone.
  if (request.durable) throw new Error("coordinator is memory-only; omit durable or pass false.");
  if (!pickTools(request.tools).includes("codemode")) throw new Error("coordinator requires explicitly permitted codemode in tools.");
  const plan = coordinatorSchema.parse(coordinator);
  if (plan.saveDir !== undefined) checkSavePath(plan.saveDir, "coordinator.saveDir");
  return { ...request, createTools: (worker) => createCoordinatorTools(plan, worker.cwd,
    { startBatch, waitForMany, getState, followUp }, (fields) => {
      if (fields.reportIndex !== undefined) worker.reportIndex = fields.reportIndex;
      worker.reportIndexError = fields.reportIndexError;
      worker.onChange?.();
    }) };
}

async function checkCoordinatorAttachments(plan: CoordinatorOptions | undefined): Promise<void> {
  // A coordinator plan's files are checked now, so a bad path fails this call, not a later dispatch.
  // Each member's own list, as dispatch will read it: limits apply per member, and a default every
  // member replaces is never read.
  const lists = new Map((plan?.tasks ?? []).map((t) => t.attachments ?? plan?.attachments ?? [])
    .filter((paths) => paths.length).map((paths) => [JSON.stringify(paths), paths]));
  for (const paths of lists.values()) await readTextFiles(paths, "coordinator.attachments");
}

const inline = async ({ attachments, ...request }: PreparedRequest): Promise<LaunchRequest> => {
  await checkCoordinatorAttachments(request.coordinator);
  return { ...withCoordinator(request), prompt: await withAttachments(request.prompt, attachments) };
};

export async function startExecution(request: AttachedRequest) {
  const w = await launch(await inline(await withFork(request)));
  return {
    sessionId: w.id,
    ...(w.forkedFrom ? { forkedFrom: w.forkedFrom } : {}),
    label: w.label,
    state: observedState(w),
    model: w.model,
    thinking: w.thinking,
    activeTools: w.activeTools,
    limits: { maxTurns: w.maxTurns, maxDurationMs: w.maxDurationMs },
    next: WAIT_HINT,
  };
}

/** Returned with a started run, so the caller's next call collects the answer in one loop. */
const WAIT_HINT = "Call wait with this sessionId, until \"settled\".";

export interface BatchRequest extends Omit<LaunchRequest, "prompt" | "id" | "label"> {
  tasks: AttachedRequest[];
  prompt?: string | undefined;
  attachments?: string[] | undefined;
  saveDir?: string | undefined;
  idPrefix?: string;
  forkFrom?: string;
  coordinator?: CoordinatorOptions | undefined;
}

export async function startBatch({
  tasks, prompt, model, thinking, fallbackModels, cwd, tools, extensions, durable, nativeMcp, mcpServers, forkFrom, resources,
  maxTurns, maxDurationMs, maxToolCalls, retentionDays, idPrefix, attachments, saveDir, coordinator,
}: BatchRequest) {
  const width = Math.max(String(tasks.length).length, 2);
  const seeds = new Map<string, ReturnType<PiWorker["forkSeed"]>>();
  const merged: PreparedRequest[] = [];
  for (const [i, t] of tasks.entries()) merged.push(await withFork({
    // A coordinator keeps its default synthesis unless the task itself names a prompt.
    prompt: t.prompt ?? ((t.coordinator ?? coordinator) ? undefined : prompt),
    attachments: t.attachments ?? attachments,
    saveDir,
    label: t.label,
    model: t.model ?? model,
    fallbackModels: t.fallbackModels ?? fallbackModels,
    thinking: t.thinking ?? thinking,
    cwd: t.cwd ?? cwd,
    tools: t.tools ?? tools,
    extensions: t.extensions ?? extensions,
    resources: t.resources ?? resources,
    durable: t.durable ?? durable,
    nativeMcp: t.nativeMcp ?? nativeMcp,
    mcpServers: t.mcpServers ?? mcpServers,
    maxTurns: t.maxTurns ?? maxTurns,
    maxDurationMs: t.maxDurationMs ?? maxDurationMs,
    maxToolCalls: t.maxToolCalls ?? maxToolCalls,
    // The batch's retentionDays is for its durable tasks; a task may still opt out with durable: false.
    retentionDays: t.retentionDays ?? ((t.durable ?? durable) === true ? retentionDays : undefined),
    id: t.id ?? (idPrefix ? `${idPrefix}-${String(i + 1).padStart(width, "0")}` : undefined),
    forkFrom: t.forkFrom ?? forkFrom,
    coordinator: t.coordinator ?? coordinator,
  }, seeds));

  // Validate the batch up front. Every check here is cheap and deterministic, and a
  // half-started fan-out is the worst outcome: you pay for the delegates that launched
  // and still have to work out which ones did not.
  if (retentionDays !== undefined && !merged.some((t) => t.durable === true))
    throw new Error("retentionDays applies only to durable delegates; pass durable: true for the batch or its tasks.");
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
      withCoordinator(t);
      await checkCoordinatorAttachments(t.coordinator);
      const taskCwd = await resolveDelegateCwd(t.cwd ?? cwd);
      validateNativeMcp(t, taskCwd);
      t.preparedResources = await prepareResources(t.resources, taskCwd, pickTools(t.tools));
      // The model the task will really run on, including Pi's own default, and its credentials:
      // a task that would fail after its siblings started must stop the whole batch here.
      const modelRef = t.model || defaultModelRef(taskCwd);
      // With no model named anywhere, Pi would pick one only once the session exists, after the
      // siblings started; a batch must know every model up front.
      if (!modelRef)
        throw new Error("no model is named and no default is configured; pass model for this task, " +
          "or set PI_DELEGATE_MODEL or Pi's default model.");
      const taskModel = await resolveModel(modelRef, taskCwd);
      assertThinkingSupported(taskModel, t.thinking);
      if (taskModel) await assertProviderReady(taskModel.provider);
      t.prompt = await withAttachments(t.prompt, t.attachments);
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
    forkedFrom?: string;
    limits: { maxTurns: number; maxDurationMs: number };
  }> = [];
  const failures: Array<{ index: number; id?: string; error: string }> = [];
  const results = await launchBatch(merged.map(({ attachments: _inlined, ...task }) => withCoordinator(task)));
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const w = result.value;
      started.push({
        index,
        sessionId: w.id,
        ...(w.forkedFrom ? { forkedFrom: w.forkedFrom } : {}),
        label: w.label,
        state: observedState(w),
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
    sessionIds: started.map((s) => s.sessionId),
    sessions: started,
    // Only reachable if a session dies during construction, after validation passed.
    ...(failures.length ? { failed: failures.length, failures } : {}),
  };
}

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { state: Snapshot["state"]; turns: number }) => void | Promise<void>;
  verbose?: boolean;
}

export async function runExecution(
  attached: AttachedRequest,
  { signal, onProgress, verbose }: RunOptions = {},
): Promise<Snapshot> {
  const request = await inline(await withFork(attached));
  // Bind cancellation as soon as the worker exists, before it starts: a caller that has already
  // cancelled, or cancels during start, must not have Pi prompted at all.
  let unbindCancellation = (): void => {};
  const w = await launch({
    ...request,
    maxTurns: request.maxTurns ?? RUN_DEFAULT_TURNS,
    maxDurationMs: request.maxDurationMs ?? RUN_DEFAULT_DURATION_MS,
  }, (worker) => {
    if (signal) unbindCancellation = bindCancellation(signal, async () => { await worker.abort("caller_cancelled"); });
  });
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
  const snap = w.snapshot({ verbose, diagnostics: verbose });
  evictHistory();
  return snap;
}

export async function getState(sessionId: string, verbose?: boolean): Promise<Snapshot> {
  return stored(sessionId, verbose) ?? waitingSnapshot(await resolve(sessionId), verbose);
}

/**
 * progress: a new turn or tool call, as well as everything below. settled: finished or asking a
 * question, so a caller can wait for the result in one loop. all_settled: with several sessions,
 * every one of them settled (a question in any still returns at once).
 */
export type WaitUntil = "progress" | "settled" | "all_settled";

export interface WaitOptions {
  timeoutMs?: number;
  afterTurns?: number;
  afterToolCalls?: number;
  verbose?: boolean;
  until?: WaitUntil;
  signal?: AbortSignal;
}

/** A session being waited on: live in this process, or finished and read from the catalog. */
type Watched = { id: string; worker?: PiWorker; finished?: Snapshot; turns: number; calls: number };

const finishedNow = (w: Watched): boolean => w.finished !== undefined || hasFinished(w.worker!);
const settledNow = (w: Watched): boolean => finishedNow(w) || w.worker!.questions.size > 0;
const progressed = (w: Watched): boolean =>
  settledNow(w) || w.worker!.turns > w.turns || w.worker!.toolCalls.length > w.calls;

async function watch(ids: string[], afterTurns?: number, afterToolCalls?: number): Promise<Watched[]> {
  return Promise.all(ids.map(async (id) => {
    // A finished session elsewhere cannot progress; its recorded state is the answer.
    const finished = stored(id, true);
    if (finished) return { id, finished, turns: finished.turns, calls: finished.toolCallCount };
    const worker = await resolve(id);
    return { id, worker, turns: afterTurns ?? worker.turns, calls: afterToolCalls ?? worker.toolCalls.length };
  }));
}

function until(watched: Watched[], mode: WaitUntil, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const done = (): boolean => mode === "progress" ? watched.some(progressed)
    : mode === "settled" ? watched.some(settledNow)
    : watched.every(settledNow) || watched.some((w) => w.worker !== undefined && w.worker.questions.size > 0);
  if (done() || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let over = false;
    const finish = (): void => {
      if (over) return;
      over = true;
      clearInterval(poll);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const poll = setInterval(() => { if (done()) finish(); }, 200);
    const timeout = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function waitForState(
  sessionId: string,
  { timeoutMs = 30_000, afterTurns, afterToolCalls, verbose, until: mode = "progress", signal }: WaitOptions = {},
): Promise<Snapshot> {
  const [watched] = await watch([sessionId], afterTurns, afterToolCalls);
  if (watched!.finished) return verbose ? watched!.finished : compactSnapshot(watched!.finished);
  await until([watched!], mode, timeoutMs, signal);
  return waitingSnapshot(watched!.worker!, verbose);
}

/** One line per session: enough to decide what to read next, plus the answer once it is done. */
export interface WaitSummary extends FollowUpInfo {
  sessionId: string;
  forkedFrom?: string;
  label: string | undefined;
  state: string;
  turns: number;
  toolCallCount: number;
  touchedFiles?: Snapshot["touchedFiles"];
  editWriteCount?: number;
  pendingQuestions: number;
  /** Present while it waits for an answer, so answer needs no extra status call. */
  questions?: Snapshot["questions"];
  lastText?: string;
  error?: string;
  termination?: Snapshot["termination"];
  usage?: Snapshot["usage"];
  savedTo?: string;
  savedChars?: number;
  saveError?: string;
  reportIndex?: string;
  reportIndexError?: string;
  notices?: Snapshot["notices"];
  answerState?: Snapshot["answerState"];
  idleMs?: number;
  phase?: Snapshot["phase"];
}

/**
 * Wait on several sessions at once, for example a spawn_batch fan-out. Returns which are settled,
 * which are still pending, and a summary of each; finished ones carry their final text.
 */
export async function waitForMany(
  sessionIds: string[],
  { timeoutMs = 30_000, until: mode = "settled", signal }: Omit<WaitOptions, "afterTurns" | "afterToolCalls" | "verbose"> = {},
): Promise<{ settled: string[]; pending: string[]; continueIds: string[]; sessions: WaitSummary[] }> {
  const ids = [...new Set(sessionIds)];
  const watched = await watch(ids);
  await until(watched, mode, timeoutMs, signal);
  const sessions = watched.map((w): WaitSummary => {
    const s = w.finished ? compactSnapshot(w.finished) : waitingSnapshot(w.worker!);
    const done = TERMINAL.has(s.state);
    const notices = done ? s.notices : s.notices.filter((n) => n.type !== "info");
    return {
      sessionId: s.sessionId, label: s.label, state: s.state, turns: s.turns, toolCallCount: s.toolCallCount,
      ...(s.forkedFrom ? { forkedFrom: s.forkedFrom } : {}),
      ...(s.editWriteCount ? { touchedFiles: s.touchedFiles, editWriteCount: s.editWriteCount } : {}),
      pendingQuestions: s.questions.length,
      ...(s.questions.length ? { questions: s.questions } : {}),
      ...(done && s.savedTo ? { savedTo: s.savedTo, savedChars: s.savedChars } : {}),
      ...(done && !omitsSavedText(s) ? { lastText: s.lastText } : {}),
      ...(s.saveError ? { saveError: s.saveError } : {}),
      ...(s.reportIndex ? { reportIndex: s.reportIndex } : {}),
      ...(s.reportIndexError ? { reportIndexError: s.reportIndexError } : {}),
      ...(notices.length ? { notices } : {}),
      ...(s.answerState ? { answerState: s.answerState } : {}),
      ...(s.error ? { error: s.error } : {}),
      ...(s.termination ? { termination: s.termination } : {}),
      ...(done && s.usage ? { usage: s.usage } : {}),
      ...(s.idleMs !== undefined ? { idleMs: s.idleMs, phase: s.phase } : {}),
      remainingTurns: s.remainingTurns,
      canFollowUp: s.canFollowUp,
      ...(s.followUpBlockedReason ? { followUpBlockedReason: s.followUpBlockedReason } : {}),
    };
  });
  const isSettled = (s: WaitSummary): boolean => TERMINAL.has(s.state) || s.pendingQuestions > 0;
  return {
    settled: sessions.filter(isSettled).map((s) => s.sessionId),
    pending: sessions.filter((s) => !isSettled(s)).map((s) => s.sessionId),
    // Not finished yet, including those waiting for an answer: keep waiting on these after answering.
    continueIds: sessions.filter((s) => !TERMINAL.has(s.state)).map((s) => s.sessionId),
    sessions,
  };
}

export async function steerExecution(sessionId: string, text: string) {
  return (await resolve(sessionId)).steer(text);
}

export async function resolveInteraction(sessionId: string, requestId: string, value: string | boolean) {
  return (await resolve(sessionId)).answer(requestId, value);
}

export async function followUp(sessionId: string, prompt: string, attachments?: string[], saveTo?: string, budget: FollowUpBudget = {}) {
  const text = await withAttachments(prompt, attachments);
  if (saveTo !== undefined) checkSavePath(saveTo);
  const worker = await resolve(sessionId);
  // forget/eviction can remove a worker while resolve is finishing a shared lazy load.
  if (loaded(sessionId) !== worker)
    throw new Error(`Session ${sessionId} was forgotten or unloaded while loading. Check status before follow_up.`);
  // Let the worker produce the more useful "use steer" error for a live session.
  if (!worker.isActive) assertCapacity();
  // Each run states its own destination; a follow_up without saveTo returns its text inline.
  const previousSaveTo = worker.saveTo;
  worker.saveTo = saveTo;
  try { return { ...await worker.followUp(text, budget), model: worker.model,
    thinking: worker.thinking, state: observedState(worker), next: WAIT_HINT }; }
  catch (error) { worker.saveTo = previousSaveTo; throw error; }
}

export async function cancelExecution(sessionId: string) {
  return (await resolve(sessionId)).abort();
}

/** cwd, when supplied, is the canonical project path, as for a worker's cwd. */
export function listSessions(state?: string, verbose?: boolean, cwd?: string) {
  const workers = all();
  const filtered = workers.filter((w) => (state === undefined || observedState(w) === state) && (cwd === undefined || w.cwd === cwd))
    .map((w) => waitingSnapshot(w, verbose));
  const list = verbose
    ? filtered
    : filtered.map((s) => ({
        sessionId: s.sessionId,
        ...(s.forkedFrom ? { forkedFrom: s.forkedFrom } : {}),
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
        cwd: s.cwd,
        remainingTurns: s.remainingTurns,
        canFollowUp: s.canFollowUp,
        ...(s.followUpBlockedReason ? { followUpBlockedReason: s.followUpBlockedReason } : {}),
      }));
  const loaded = new Set(workers.map((w) => w.id));
  const stored = storedJobs(cwd).filter((job) => !loaded.has(job.sessionId) && (state === undefined || job.state === state));
  return { count: list.length, sessions: list, stored };
}

export async function forgetSession(sessionId: string) {
  await forget(sessionId);
  return { forgotten: sessionId };
}
