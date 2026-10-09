import { randomUUID } from "node:crypto";
import {
  type AgentSessionEvent,
  type ExtensionUIContext,
  type CreateAgentSessionResult,
  type FileEntry,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { DurableJob, forgetOwnedJob, MemoryJob, releaseJob, type Checkpoint, type JobStore } from "../durable.js";
import { MAX_TURNS, RETENTION_DAYS, STALL_MS } from "../config.js";
import { JUDGE_ENABLED, judgeAnswer } from "../judge.js";
import { saveText } from "../save.js";
import { message } from "../errors.js";
import { followUpInfo } from "../continuation.js";
import { validateNativeMcp, type NativeMcpOptions } from "./native-mcp.js";
import type {
  Notice,
  PiThinkingLevel,
  SessionState,
  Snapshot,
  Termination,
  TerminationReason,
  ToolCall,
  Usage,
} from "../types.js";
import { assertProviderReady, assertThinkingSupported, resolveModel } from "./models.js";
import { clipArgs, flatten } from "./trace.js";
import { createUiContext, Question } from "./ui.js";
import { prepareResources, type ResourceSelection, type PreparedResources } from "./resources.js";
import { WorkerRun, type FollowUpBudget, type RunBudget } from "./run.js";
import { FINALIZE_PROMPT, LAST_TURN_PROMPT, PROVIDER_REFUSAL } from "./prompts.js";
import { nestedResults, repairEntries } from "./repair.js";
import { createSession, loadResources, type SessionSpec } from "./session.js";
import { compactSnapshot } from "./snapshot.js";

type AgentSession = CreateAgentSessionResult["session"];

const NOOP = (): void => {};

export interface WorkerOptions extends NativeMcpOptions {
  id?: string | undefined;
  label?: string | undefined;
  cwd: string;
  model?: string | undefined;
  thinking?: PiThinkingLevel | undefined;
  tools: string[];
  extensions?: boolean;
  resources?: ResourceSelection | undefined;
  /** True saves and recovers the delegate. Default false: memory only, as for MCP callers. */
  durable?: boolean;
  /** Days to keep a finished durable delegate; RETENTION_DAYS when absent. */
  retentionDays?: number | undefined;
  maxTurns: number;
  maxDurationMs: number;
  /** Initial own-tool-call quota; follow-ups share it unless renewed. Nested calls (codemode, MCP) do not count. */
  maxToolCalls?: number | undefined;
  startedAt?: string;
  forkedFrom?: string;
  /** Full inherited usage, retained in entries for SDK context accounting but excluded from this task. */
  usageBaseline?: Usage;
}

/**
 * One delegated Pi session. The SDK remains live for steering and questions; durable
 * checkpoints retain the conversation and task progress across process restarts.
 * Event ordering and completion rules: docs/worker-lifecycle.md.
 */
export class PiWorker {
  /** Runtime protocol adapters. Deliberately separate from persisted task options. */
  customTools: ToolDefinition[] = [];
  /** Prepared by admission so batch resource failures occur before any launch. */
  preparedResources: PreparedResources | undefined;
  /** Session-level publication receipts; coordinator follow-ups keep the same team index. */
  reportIndex: string | undefined;
  reportIndexError: string | undefined;
  readonly forkedFrom: string | undefined;
  readonly id: string;
  readonly label: string | undefined;
  readonly cwd: string;
  readonly toolNames: string[];
  readonly startedAt: string;
  /**
   * Control state of the current spawn or follow_up. The wall-clock limit applies
   * per run, so a session can be continued days later. Cumulative counts are kept separately from quotas. Downtime during a
   * run still counts, since recovery keeps this value.
   */
  private currentRun: WorkerRun;
  get maxTurns(): number { return this.currentRun.budget.maxTurns; }
  get maxToolCalls(): number | undefined { return this.currentRun.budget.maxToolCalls; }
  private get budgetTurns(): number { return this.turns - this.currentRun.budget.turnStart; }
  private budgetToolCalls(): number { return this.ownToolCalls() - this.currentRun.budget.toolCallStart; }
  readonly maxDurationMs: number;

  state: SessionState = "starting";
  turns = 0;
  lastText = "";
  model: string | undefined;
  activeTools: string[] | undefined;
  error: string | undefined;
  finishedAt: string | undefined;
  thinking: PiThinkingLevel | undefined;
  termination: Termination | undefined;

  readonly toolCalls: ToolCall[] = [];
  readonly notices: Notice[] = [];
  readonly questions = new Map<string, Question>();

  /** Resolves when the delegate stops, however it stops. Never rejects. */
  get run(): Promise<void> | undefined { return this.currentRun.completion; }
  /** Set by the registry so state reaches the status line on every transition. */
  onChange: (() => void) | undefined;

  private readonly extensionsEnabled: boolean;
  private readonly nativeMcp: boolean;
  private readonly mcpServers: string[];
  private nativeClose: Promise<void> | undefined;
  private readonly modelSpec: string | undefined;
  private readonly thinkingSpec: PiThinkingLevel | undefined;
  private readonly openCalls = new Map<string, ToolCall>();
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private job: JobStore | undefined;
  recoveryKey: string | undefined;
  /** A failed executor close retains ownership and its diagnostic worker until cleanup succeeds. */
  recoveryCleanupFailed = false;
  private journalUnsubscribe: (() => void) | undefined;
  private suspended = false;
  /** File the next finished run's text goes to, set by whoever starts the run; kept in memory only. */
  saveTo: string | undefined;
  private saved: { savedTo: string; savedChars: number } | { saveError: string } | undefined;
  /** Set when a run finishes: cut off, or judged narration. "missing" is derived from lastText. */
  private answerFlag: "partial" | "narration" | undefined;
  private recordingStopped = false;
  private inputStarted = false;
  private readonly results: Checkpoint["results"] = {};
  private steering: string[] = [];
  private recoveryInput: Checkpoint["recoveryInput"];
  private options: WorkerOptions;

  get durable(): boolean {
    return this.options.durable !== false;
  }

  /** How long this delegate stays on disk after finishing; undefined when it is not durable. */
  get retentionDays(): number | undefined {
    return this.durable ? this.options.retentionDays ?? RETENTION_DAYS : undefined;
  }

  /** Cancelling a session does not release its concurrency slot until the SDK becomes idle. */
  get isActive(): boolean {
    return this.state === "starting" || this.state === "running" || this.currentRun.abortPromise !== undefined || this.currentRun.settling;
  }

  get continuation() {
    return followUpInfo(this.state, this.budgetTurns, this.maxTurns,
      this.recoveryCleanupFailed ? "cleanup_failed"
        : this.isActive ? (["starting", "running"].includes(this.state) ? "running" : "finalizing")
        : !this.session ? "not_started" : undefined);
  }

  private isStopped(): boolean {
    return this.state === "aborted" || this.suspended;
  }

  private clearQuestions(): void {
    for (const q of this.questions.values()) q.resolve(undefined);
    this.questions.clear();
  }

  /** The model's own calls; calls made inside a codemode script or an MCP tool do not count. */
  private ownToolCalls(): number {
    return this.toolCalls.filter((call) => !call.parentToolCallId).length;
  }

  private toolCallsSpent(): boolean {
    return this.maxToolCalls !== undefined && this.budgetToolCalls() >= this.maxToolCalls;
  }

  /** The previous run's text, saved file and answer flag, which a new run replaces. */
  private clearResult(): void {
    this.lastText = "";
    this.answerFlag = undefined;
    this.saved = undefined;
  }

  private newRun(preserveReceipt = false): WorkerRun {
    this.currentRun.clearTimers();
    const run = new WorkerRun(this.currentRun.startedAt, { ...this.currentRun.budget });
    // A follow_up may be refused during authentication, leaving the previous result intact.
    if (preserveReceipt) {
      run.touchedFiles = new Set(this.currentRun.touchedFiles);
      run.editWriteCount = this.currentRun.editWriteCount;
    }
    return this.currentRun = run;
  }

  constructor({
    id,
    label,
    cwd,
    model,
    thinking,
    tools,
    extensions = false,
    durable = false,
    retentionDays,
    nativeMcp = false,
    mcpServers = [],
    maxTurns,
    maxDurationMs,
    maxToolCalls,
    startedAt,
    forkedFrom,
    usageBaseline,
    resources,
  }: WorkerOptions) {
    this.id = id ?? randomUUID();
    this.forkedFrom = forkedFrom;
    this.label = label;
    this.cwd = cwd;
    this.modelSpec = model;
    this.thinkingSpec = thinking;
    this.toolNames = tools;
    this.extensionsEnabled = extensions;
    this.nativeMcp = nativeMcp;
    this.mcpServers = [...mcpServers];
    this.maxDurationMs = maxDurationMs;
    this.startedAt = startedAt ?? new Date().toISOString();
    this.currentRun = new WorkerRun(this.startedAt, { maxTurns, maxToolCalls, turnStart: 0, toolCallStart: 0 });
    this.options = { id: this.id, label, cwd, model, thinking, tools, extensions, resources, durable, retentionDays, nativeMcp, mcpServers: this.mcpServers, maxTurns, maxDurationMs,
      ...(maxToolCalls !== undefined ? { maxToolCalls } : {}), startedAt: this.startedAt,
      ...(forkedFrom ? { forkedFrom, usageBaseline } : {}) };
  }

  private uiContext(): ExtensionUIContext {
    return createUiContext({
      ask: (kind, title, detail, options) => {
        if (this.isStopped()) return Promise.resolve(undefined);
        const q = new Question(kind, title, detail, options);
        this.questions.set(q.id, q);
        this.onChange?.();
        return q.promise;
      },
      notify: (message, type = "info") => {
        this.notices.push({ type, message, at: new Date().toISOString() });
      },
    });
  }

  async start(prompt: string, saved?: Checkpoint, key?: string, seedEntries?: FileEntry[]): Promise<this> {
    validateNativeMcp(this.options, this.cwd);
    const model = await resolveModel(this.modelSpec, this.cwd);
    if (this.isStopped()) return this;

    assertThinkingSupported(model, this.thinkingSpec);

    const selectedResources = this.preparedResources ?? await prepareResources(this.options.resources, this.cwd, this.toolNames);
    this.preparedResources = undefined;
    const spec: SessionSpec = { cwd: this.cwd, tools: this.toolNames, extensions: this.extensionsEnabled,
      nativeMcp: this.nativeMcp, mcpServers: this.mcpServers, resources: this.options.resources ? selectedResources : undefined,
      customTools: this.customTools, journal: this.nestedCalls ? this.nativeExecutionJournal() : undefined };
    const resourceLoader = await loadResources(spec);
    if (this.isStopped()) return this;

    const session = await createSession(spec, resourceLoader, { model, thinking: this.thinkingSpec, saved, seedEntries });
    this.session = session;
    if (this.isStopped()) {
      session.dispose();
      return this;
    }
    // Record the model Pi actually chose, so recovery resolves the same one. A placeholder in the
    // stored options would not resolve.
    const chosen = model ?? session.model;
    if (!model && chosen) {
      // SDK defaults must obey the same delegate policy as an explicit model.
      try {
        await resolveModel(`${chosen.provider}/${chosen.id}`, this.cwd);
        assertThinkingSupported(chosen, this.thinkingSpec);
      } catch (error) { session.dispose(); throw error; }
    }
    this.model = chosen ? `${chosen.provider}/${chosen.id}` : "(pi default)";
    this.thinking = session.thinkingLevel;
    this.activeTools = session.getActiveToolNames();

    this.unsubscribe = session.subscribe((ev) => this.onEvent(ev));
    await session.bindExtensions({ uiContext: this.uiContext(), mode: "rpc" });
    // SDK tools is both the registration allowlist and initial active set. Permit the injected
    // codemode tools, then remove their direct declarations; scripts can still call them.
    if (this.customTools.length) {
      session.setActiveToolsByName(this.toolNames);
      this.activeTools = session.getActiveToolNames();
    }
    if (this.isStopped()) {
      this.dispose();
      await this.nativeClose;
      return this;
    }
    this.options = { ...this.options, model: chosen ? this.model : undefined, thinking: this.thinking };
    this.job = this.options.durable === false ? new MemoryJob()
      : await DurableJob.open(this.options, prompt, key, seedEntries ? this.checkpoint() : undefined);
    if (this.isStopped()) {
      await this.job.close();
      this.dispose();
      await this.nativeClose;
      return this;
    }
    // AgentSession has persisted message_end before this awaited listener runs.
    // Tool-start saves must finish before the SDK proceeds to execution.
    this.journalUnsubscribe = session.agent.subscribe(async (ev) => {
      if (this.recordingStopped) return;
      if (ev.type === "message_end" && ev.message.role === "user") {
        this.inputStarted = true;
        const text = typeof ev.message.content === "string" ? ev.message.content :
          ev.message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        if (text === this.recoveryInput?.text) {
          this.steering.splice(0, this.recoveryInput.steeringCount);
          this.recoveryInput = undefined;
        } else {
          const index = this.steering.indexOf(text);
          if (index >= 0) this.steering.splice(index, 1);
        }
      }
      if (ev.type === "tool_execution_end") this.results[ev.toolCallId] = {
        name: ev.toolName, content: ev.result.content, details: ev.result.details, isError: ev.isError,
      };
      if (ev.type === "message_end" && ev.message.role === "toolResult") this.clearResults(ev.message.toolCallId);
      // MemoryJob.save is a no-op; avoid copying the session just to discard it.
      if (this.durable && ["turn_start", "turn_end", "message_end", "tool_execution_start", "tool_execution_end", "agent_end"].includes(ev.type))
        await this.job!.save(this.checkpoint());
    });
    if (saved && !this.job.needsResume) {
      this.restoreSnapshot(saved);
      this.recordFinal();
    } else {
      await this.beginDurable(prompt, saved, Boolean(key));
    }
    return this;
  }

  /** A settled transcript and its configuration, without the parent's execution state. */
  forkSeed() {
    if (this.isActive || !["done", "error", "aborted"].includes(this.state))
      throw new Error(`Session ${this.id} is still active; wait for it to settle before forking.`);
    if (!this.session) throw new Error(`Session ${this.id} never started, nothing to fork.`);
    const stats = this.session.getSessionStats();
    const { input, output, cacheRead, cacheWrite, total } = stats.tokens;
    return {
      entries: repairEntries(structuredClone(this.checkpoint())),
      usageBaseline: { input, output, cacheRead, cacheWrite, totalTokens: total, cost: stats.cost },
      inherited: { cwd: this.cwd, tools: [...this.toolNames], model: this.model,
        thinking: this.thinking, extensions: this.extensionsEnabled, nativeMcp: this.nativeMcp,
        mcpServers: [...this.mcpServers], resources: structuredClone(this.options.resources) },
    };
  }

  /** Tools that run other tools (native MCP, codemode): their nested calls are journalled too. */
  private get nestedCalls(): boolean {
    return this.nativeMcp || this.toolNames.includes("codemode");
  }

  private nativeExecutionJournal(): InlineExtension {
    return { name: "delegate-native-journal", hidden: true, factory: (pi) => {
      pi.on("before_agent_start", () => {
        this.activeTools = pi.getActiveTools();
      });
      pi.on("context_with_system", (event) => {
        if (this.budgetTurns < this.maxTurns && !this.toolCallsSpent()) return;
        // Native tools register asynchronously, including during the first prompt. Enforce
        // the answer-only turn after registration, on the actual request transcript.
        this.lastTurn();
        return { messages: event.messages.map((message) => {
          if (message.role !== "system") return message;
          const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
          return rest;
        }) };
      });
      pi.on("tool_call", async (ev) => {
        if (this.suspended || !this.job) return { block: true, reason: "Delegate is suspended or has not entered its durable task." };
        // The nested start event has already updated the trace. This hook propagates
        // commit failures (ordinary extension event listeners only report them).
        if (this.durable && ev.parentToolCallId) await this.job.save(this.checkpoint());
        return undefined;
      });
      pi.on("tool_execution_start", (ev) => {
        if (ev.parentToolCallId) this.onEvent(ev);
      });
      pi.on("tool_execution_end", async (ev) => {
        if (!ev.parentToolCallId || this.recordingStopped) return;
        this.onEvent(ev);
        this.results[ev.toolCallId] = { name: ev.toolName, content: ev.result.content,
          details: ev.result.details, isError: ev.isError, parentToolCallId: ev.parentToolCallId };
        if (this.durable) await this.job!.save(this.checkpoint());
      });
    } };
  }

  private clearResults(parentId: string): void {
    const nested = nestedResults(this.results, this.toolCalls, parentId);
    delete this.results[parentId];
    for (const [id] of nested) delete this.results[id];
  }

  private checkpoint(): Checkpoint {
    const manager = this.session!.sessionManager;
    return { phase: "execute", entries: [manager.getHeader()!, ...manager.getEntries()],
      snapshot: this.snapshot({ verbose: true }), inputStarted: this.inputStarted,
      results: this.results, steering: this.steering,
      ...(this.recoveryInput ? { recoveryInput: this.recoveryInput } : {}) };
  }

  private restoreSnapshot(saved: Checkpoint): void {
    const snapshot = saved.snapshot;
    this.currentRun.startedAt = snapshot.runStartedAt ?? snapshot.startedAt;
    this.currentRun.budget = { maxTurns: snapshot.limits.maxTurns, maxToolCalls: snapshot.limits.maxToolCalls,
      turnStart: snapshot.budgetStart?.turns ?? 0, toolCallStart: snapshot.budgetStart?.toolCalls ?? 0 };
    this.state = snapshot.state;
    this.turns = snapshot.turns;
    this.lastText = snapshot.lastText;
    this.error = snapshot.error;
    this.finishedAt = snapshot.finishedAt;
    this.termination = snapshot.termination;
    this.answerFlag = snapshot.answerState === "missing" ? undefined : snapshot.answerState;
    this.saved = snapshot.savedTo ? { savedTo: snapshot.savedTo, savedChars: snapshot.savedChars ?? 0 }
      : snapshot.saveError ? { saveError: snapshot.saveError } : undefined;
    // Old checkpoints have no receipt. Their cumulative tool trace cannot establish a run boundary.
    this.currentRun.touchedFiles = new Set(snapshot.touchedFiles ?? []);
    this.currentRun.editWriteCount = snapshot.editWriteCount ?? 0;
    this.toolCalls.splice(0, this.toolCalls.length, ...snapshot.toolCalls as ToolCall[]);
    this.notices.splice(0, this.notices.length, ...snapshot.notices);
    this.inputStarted = saved.inputStarted;
    Object.assign(this.results, saved.results);
    // repairEntries may have placed a saved result into the reconstructed transcript.
    for (const message of this.session!.messages) {
      if (message.role === "toolResult") this.clearResults(message.toolCallId);
    }
    this.steering = [...saved.steering];
    this.recoveryInput = saved.recoveryInput;
  }

  private async beginDurable(prompt: string, saved?: Checkpoint, recover = false, budget: FollowUpBudget = {}): Promise<void> {
    const previousBudget = { ...this.currentRun.budget };
    const previousRun = this.currentRun;
    const previousResult = { text: this.lastText, flag: this.answerFlag, saved: this.saved,
      finishedAt: this.finishedAt, error: this.error, termination: this.termination };
    const run = this.newRun(true);
    if (saved) this.restoreSnapshot(saved);
    else this.inputStarted = false;
    const alreadyStopped = recover && saved && !["starting", "running"].includes(saved.snapshot.state);
    // Check credentials only when this run will call the model: spawn, follow_up, or a recovery
    // that still has work. A recovery that only records an answer already given must not fail
    // because a provider's auth broke meanwhile.
    const last = recover && saved?.inputStarted ? this.session!.messages.at(-1) : undefined;
    const answered = recover && saved?.inputStarted && !this.steering.length &&
      last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
    // A recovery already past its budget is only marked aborted, so it needs no model either.
    const overBudget = recover && (this.budgetTurns >= this.maxTurns || this.elapsedMs() >= this.maxDurationMs);
    const provider = this.model?.includes("/") ? this.model.slice(0, this.model.indexOf("/")) : undefined;
    if (!alreadyStopped && !answered && !overBudget && provider) {
      try { await assertProviderReady(provider); }
      catch (error) { if (this.currentRun === run && !this.isStopped()) throw error; }
    }
    // Authentication may refresh OAuth over the network. An abort or shutdown received during
    // that await still wins; cancelled runs commit their terminal state without prompting Pi.
    // An abort during that await also lets a new follow_up start; this execution is then superseded.
    if (this.suspended || this.currentRun !== run) return;
    if (!recover) {
      if (this.state !== "aborted") run.startedAt = new Date().toISOString();
      // From here this follow_up replaces the previous result, even if it is cancelled before Pi runs;
      // a follow_up refused above leaves that result as it was.
      this.clearResult();
      run.touchedFiles.clear();
      run.editWriteCount = 0;
    }
    if (!alreadyStopped && this.state !== "aborted") {
      this.state = "running";
      this.finishedAt = undefined;
      this.error = undefined;
      this.termination = undefined;
    }
    run.settling = true;
    let accepted = false;
    try {
      // Stage quotas in the new task's checkpoint without changing the old task's live state.
      // abort() during creation must not save an uncommitted renewal into the previous task.
      const checkpoint = this.checkpoint();
      const renewed = !recover && this.state !== "aborted" && (budget.maxTurns !== undefined || budget.maxToolCalls !== undefined);
      const nextBudget = renewed ? this.nextBudget(budget) : { ...run.budget };
      if (renewed) {
        checkpoint.snapshot.limits = { ...checkpoint.snapshot.limits,
          maxTurns: nextBudget.maxTurns, ...(nextBudget.maxToolCalls !== undefined ? { maxToolCalls: nextBudget.maxToolCalls } : {}) };
        checkpoint.snapshot.budgetStart = { turns: nextBudget.turnStart, toolCalls: nextBudget.toolCallStart };
        Object.assign(checkpoint.snapshot, followUpInfo(this.state, this.turns - nextBudget.turnStart, nextBudget.maxTurns));
      }
      const acceptBudget = (): void => {
        if (accepted || this.currentRun !== run) return;
        accepted = true;
        run.budget = nextBudget;
        run.restoreTools = renewed;
      };
      const { done } = await this.job!.begin(prompt, checkpoint, async (input, checkpoint, signal) => {
        const suspend = (): void => {
          run.clearTimers();
          if (this.currentRun !== run) return;
          this.suspended = true;
          this.clearQuestions();
          void this.session!.abort();
        };
        signal.addEventListener("abort", suspend, { once: true });
        try {
          // A durable task's creation also yields; cancellation may arrive while it commits.
          if (this.currentRun !== run) return checkpoint;
          acceptBudget();
          if (alreadyStopped || this.state === "aborted") return this.checkpoint();
          if (recover && checkpoint.inputStarted) {
            // Steering may arrive while job.begin yields; it still needs a model turn.
            if (answered && !this.steering.length) {
              this.state = "done";
              if (last?.role === "assistant" && last.stopReason === "length") this.answerFlag = "partial";
              this.finishedAt = new Date().toISOString();
              return this.checkpoint();
            }
            for (const call of this.toolCalls.filter((c) => c.state === "running")) {
              call.state = "error";
              call.result = "Service interrupted this call; its external effects may have completed. Inspect before retrying.";
              delete call.startedAt;
            }
            this.notices.push({ type: "info", at: new Date().toISOString(), message: "Recovered saved conversation after MCP service restart." });
            input = this.recoveryInput?.text ?? "The MCP service restarted. Continue the original task from the saved conversation. " +
              "Do not repeat completed work. Interrupted tools may already have applied external effects; inspect before retrying." +
              (this.steering.length ? "\nPending steering instructions:\n" + this.steering.join("\n") : "");
            this.recoveryInput ??= { text: input, steeringCount: this.steering.length };
          }
          if (this.budgetTurns >= this.maxTurns || this.elapsedMs() >= this.maxDurationMs) {
            await this.abort(this.budgetTurns >= this.maxTurns ? "max_turns" : "deadline");
          } else await this.track(this.session!, input, run);
          if (this.suspended) {
            // suspend() first drains a checkpoint, then closes the Harness. If the SDK
            // finishes between those steps, wait for close's cancellation instead of
            // faulting a task which must remain recoverable.
            if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            signal.throwIfAborted();
          }
          return this.checkpoint();
        } finally { signal.removeEventListener("abort", suspend); }
      }, recover);
      // Harness may run the callback before begin() returns; either path accepts only once.
      acceptBudget();
      run.completion = done.then(() => {}).catch((error: unknown) => {
        if (this.currentRun !== run || this.suspended) return;
        this.state = "error";
        this.error = message(error);
        this.finishedAt = new Date().toISOString();
      }).finally(() => {
        run.settling = false;
        if (this.currentRun !== run) return;
        try { this.recordFinal(); }
        catch (error) {
          this.state = "error";
          this.error = `Final result persistence failed: ${message(error)}`;
          this.finishedAt ??= new Date().toISOString();
        }
        this.onChange?.();
      });
    } catch (error) {
      run.settling = false;
      run.clearTimers();
      if (!accepted && this.currentRun === run && !this.inputStarted) {
        run.budget = previousBudget;
        run.restoreTools = false;
        if (this.state !== "aborted") {
          run.startedAt = previousRun.startedAt;
          run.touchedFiles = new Set(previousRun.touchedFiles);
          run.editWriteCount = previousRun.editWriteCount;
          this.lastText = previousResult.text;
          this.answerFlag = previousResult.flag;
          this.saved = previousResult.saved;
          this.finishedAt = previousResult.finishedAt;
          this.error = previousResult.error;
          this.termination = previousResult.termination;
        }
      }
      throw error;
    }
  }

  /** Compute explicit renewals; omitted dimensions keep their existing boundary. */
  private nextBudget(budget: FollowUpBudget): RunBudget {
    const next = { ...this.currentRun.budget };
    if (budget.maxTurns !== undefined) { next.maxTurns = budget.maxTurns; next.turnStart = this.turns; }
    if (budget.maxToolCalls !== undefined) { next.maxToolCalls = budget.maxToolCalls; next.toolCallStart = this.ownToolCalls(); }
    return next;
  }

  static async recover(options: WorkerOptions, prompt: string, key: string, worker = new PiWorker(options)): Promise<PiWorker> {
    // Read without scheduling. The journal is closed before start reopens it as executor.
    const job = await DurableJob.open(options, prompt, key);
    worker.job = job;
    let saved: Checkpoint | undefined;
    try { saved = await job.saved(); }
    finally { await job.close(false); }
    worker.job = undefined;
    return worker.start(prompt, saved, key);
  }

  async suspend(): Promise<void> {
    this.suspended = true;
    this.currentRun.clearTimers();
    // abort() synchronously signals the agent before waiting for idle. Keep the
    // journal active while in-flight tools settle, including successful results.
    this.clearQuestions();
    await this.session?.abort();
    if (this.job && this.session) await this.job.save(this.checkpoint());
    this.recordingStopped = true;
    await this.job?.close();
    this.dispose();
    await this.nativeClose;
  }

  /** Drop a finished delegate from memory. A durable one stays on disk until retention removes it. */
  async unload(): Promise<void> {
    this.dispose();
    await this.closeNative();
    try {
      if (this.job) await this.job.close();
      else if (this.recoveryKey) releaseJob(this.recoveryKey);
    } catch (error) { this.recoveryCleanupFailed = true; throw error; }
    this.recoveryCleanupFailed = false;
  }

  /** Native shutdown errors must not prevent closing the durable executor. */
  private async closeNative(): Promise<void> {
    try { await this.nativeClose; }
    catch (error) {
      this.notices.push({ type: "warning", message: `native cleanup failed: ${message(error)}`, at: new Date().toISOString() });
    }
  }

  /** Failed recovery keeps its attempt count; ownership is released only after the job closes. */
  async releaseRecovery(): Promise<void> {
    this.dispose();
    await this.closeNative();
    // A rejected Harness close must leave ownership held; closing=true alone is not confirmation.
    try { await this.job?.close(false); }
    catch (error) { this.recoveryCleanupFailed = true; throw error; }
    this.recoveryCleanupFailed = false;
    if (this.recoveryKey) releaseJob(this.recoveryKey);
  }

  async forgetPersistent(): Promise<void> {
    await this.closeNative();
    if (this.job) await this.job.forget();
    else if (this.recoveryKey) forgetOwnedJob(this.recoveryKey);
  }

  /**
   * Drive one prompt to completion and fold the outcome back into this worker. Shared by
   * `start` and `followUp` so a second turn behaves exactly like the first.
   */
  private track(session: AgentSession, prompt: string, run = this.newRun()): Promise<void> {
    this.state = "running";
    this.error = undefined;
    this.finishedAt = undefined;
    this.termination = undefined;
    this.clearResult();
    run.prompt = prompt;
    run.lastActivityAt = Date.now();
    if (run.restoreTools) {
      session.setActiveToolsByName(this.toolNames);
      this.activeTools = session.getActiveToolNames();
      run.restoreTools = false;
    }
    // A run with one turn left, or a session with maxTurns 1, has only its answer turn.
    if (this.budgetTurns >= this.maxTurns - 1 || this.toolCallsSpent()) this.lastTurn(session);
    const remainingMs = Math.max(1, this.maxDurationMs - this.elapsedMs());
    run.deadlineTimer = setTimeout(() => {
      if (this.currentRun !== run) return;
      this.abortForBudget("deadline", { limit: this.maxDurationMs, observed: this.elapsedMs() });
    }, remainingMs);
    // Slow turns can reach the deadline long before the turn budget's reminder, so time counts too.
    // The steer waits for a tool turn to end: the turn under way may be the answer itself, and a
    // steer queued during it would cost another turn. 2/3 leaves room for that wait.
    const shortInMs = (this.maxDurationMs * 2) / 3 - this.elapsedMs();
    if (STALL_MS > 0) run.stallTimer = setInterval(() => {
      const { idleMs, phase } = this.liveness();
      if (this.currentRun === run && phase === "model" && idleMs !== undefined && idleMs >= STALL_MS)
        this.abortForBudget("stalled", { limit: STALL_MS, observed: idleMs });
    }, Math.min(1_000, STALL_MS / 4));
    if (shortInMs > 0) run.finishTimer = setTimeout(() => {
      if (this.currentRun === run) run.timeShort = true;
    }, shortInMs);
    const execution = session
      .prompt(prompt)
      .then(() => session.waitForIdle())
      .then(async () => {
        if (this.currentRun !== run || this.state === "aborted" || this.suspended) return;
        if (run.providerError !== undefined) {
          this.state = "error";
          this.error = run.retriesExhausted
            ? `${run.providerError} (after ${run.retriesExhausted} automatic retries; consider another provider)`
            : run.providerError;
          return;
        }
        // The model finished within budget; judging and saving are not part of it.
        run.clearTimers();
        // Judge before the run counts as finished, so the caller's final wait carries the result.
        if (run.stopReason === "length") this.answerFlag = "partial";
        else if (PROVIDER_REFUSAL.test(this.lastText.trimStart())) this.answerFlag = "narration";
        else if (JUDGE_ENABLED && this.lastText.trim()) {
          const verdict = await judgeAnswer(run.prompt, this.lastText);
          // An abort during the call sets termination; this run is then not done.
          if (this.currentRun !== run || this.suspended || this.termination) return;
          this.answerFlag = verdict;
        }
        if (this.saveTo && this.lastText.trim()) {
          const path = this.saveTo;
          const saved = await saveText(path, this.lastText).catch((error: unknown) => ({ saveError: message(error) }));
          if (this.currentRun !== run) return;
          // Reported even if an abort arrived meanwhile: the file exists either way.
          this.saved = saved;
          if (this.suspended || this.termination) return;
        }
        this.state = "done";
      })
      .catch((e: unknown) => {
        if (this.currentRun === run && this.state !== "aborted" && !this.suspended) {
          this.state = "error";
          this.error = message(e);
        }
      })
      .finally(() => {
        run.clearTimers();
        if (this.currentRun !== run) return;
        if (!this.suspended) this.finishedAt = new Date().toISOString();
        // Unblock anything still waiting on an answer that will now never come.
        this.clearQuestions();
        this.onChange?.();
      });
    if (!this.job) run.completion = execution;
    return execution;
  }

  /**
   * Send another prompt to a delegate that has already finished. pi keeps the session's
   * history in durable checkpoints, so the delegate still remembers everything it read and said. This
   * is the difference between a conversation and re-explaining yourself to a fresh agent.
   */
  followUp(prompt: string, budget: FollowUpBudget = {}): { sessionId: string; state: SessionState; turnsSoFar: number } | Promise<{ sessionId: string; state: SessionState; turnsSoFar: number }> {
    if (this.recoveryCleanupFailed) throw new Error(`Session ${this.id} cleanup failed; inspect status before continuing.`);
    if (!this.session) throw new Error(`Session ${this.id} never started, nothing to follow up on.`);
    if (this.isActive)
      throw new Error(
        `Session ${this.id} is ${this.state}. Use \`steer\` to redirect a delegate that is still working.`,
      );
    for (const [name, ceiling] of [["maxTurns", MAX_TURNS], ["maxToolCalls", 1000]] as const) {
      const value = budget[name];
      if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > ceiling))
        throw new Error(`${name} must be an integer from 1 to ${ceiling}.`);
    }
    if (budget.maxTurns === undefined && this.budgetTurns >= this.maxTurns) {
      throw new Error(
        `Session ${this.id} already used ${this.budgetTurns}/${this.maxTurns} turns. Pass maxTurns to follow_up for a fresh quota, or spawn a new delegate.`,
      );
    }
    if (this.job) {
      const previous = this.state;
      this.state = "starting";
      const starting = this.beginDurable(prompt, undefined, false, budget);
      const run = this.currentRun;
      return starting.then(() => {
        if (this.currentRun === run) this.onChange?.();
        return { sessionId: this.id, state: this.state, turnsSoFar: this.turns };
      }, (error: unknown) => {
        // Refused before anything ran (for example, a provider whose credentials fail).
        if (this.currentRun === run) {
          if (this.state !== "aborted") this.state = previous;
          this.onChange?.();
        }
        throw error;
      });
    }
    const run = this.newRun();
    run.budget = this.nextBudget(budget);
    run.restoreTools = budget.maxTurns !== undefined || budget.maxToolCalls !== undefined;
    void this.track(this.session, prompt, run);
    this.onChange?.();
    return { sessionId: this.id, state: this.state, turnsSoFar: this.turns };
  }

  private onEvent(ev: AgentSessionEvent): void {
    this.currentRun.lastActivityAt = Date.now();
    switch (ev.type) {
      case "compaction_start":
        this.currentRun.compacting = true;
        this.onChange?.();
        break;

      case "compaction_end":
        this.currentRun.compacting = false;
        this.onChange?.();
        break;

      case "turn_start":
        this.currentRun.awaitingModel = true;
        // Pi starts a new turn for each automatic retry of a failed request; that is not budget spent.
        if (this.currentRun.retrying) this.currentRun.retrying = false;
        else this.turns++;
        this.onChange?.();
        break;

      case "turn_end": {
        // A tool-free turn is normally the final answer. Budget only an agent that is
        // continuing the tool loop, so a conclusion at the limit is not thrown away.
        if (this.state !== "running" || this.suspended || ev.toolResults.length === 0) break;
        if (this.budgetTurns >= this.maxTurns) {
          this.abortForBudget("max_turns", { limit: this.maxTurns, observed: this.budgetTurns });
          break;
        }
        // The last turn gets no tools, so the model answers instead of being cut off at the limit.
        // The same once the tool-call cap is reached; a turn's parallel calls may overshoot it.
        if (this.budgetTurns === this.maxTurns - 1 || this.toolCallsSpent()) {
          this.lastTurn();
          void this.session?.steer(LAST_TURN_PROMPT).catch((e: unknown) => {
            this.notices.push({ type: "warning", message: `last-turn steer failed: ${message(e)}`, at: new Date().toISOString() });
          });
          break;
        }
        const finishAt = Math.max(1, Math.floor(this.maxTurns * 0.75));
        const calls = this.budgetToolCalls();
        const callsLow = this.maxToolCalls !== undefined && calls >= Math.max(1, Math.floor(this.maxToolCalls * 0.75));
        if (this.questions.size > 0) break;
        // Models do not count their own calls: tell them the exact numbers, once, whichever budget is closest.
        const toolNote = this.maxToolCalls === undefined ? ""
          : ` You have used ${calls} of ${this.maxToolCalls} tool calls; ${this.maxToolCalls - calls} left.`;
        if (this.budgetTurns >= finishAt || callsLow)
          this.requestFinish(callsLow ? `tool calls ${calls}/${this.maxToolCalls}` : `turn budget ${this.budgetTurns}/${this.maxTurns}`,
            `You have ${this.maxTurns - this.budgetTurns} turns left, including your final answer.${toolNote}`);
        else if (this.currentRun.timeShort) {
          const left = Math.max(1, Math.round((this.maxDurationMs - this.elapsedMs()) / 1000));
          this.requestFinish(`time budget ${Math.round(this.elapsedMs() / 1000)}s/${Math.round(this.maxDurationMs / 1000)}s`,
            `About ${left} seconds remain before the hard deadline, including your final answer.`);
        }
        break;
      }

      case "tool_execution_start": {
        if (ev.toolCallId && this.toolCalls.some((call) => call.id === ev.toolCallId)) break;
        const path = (ev.args as { path?: unknown } | undefined)?.path;
        const call: ToolCall = {
          seq: this.toolCalls.length + 1,
          id: ev.toolCallId,
          name: ev.toolName,
          args: clipArgs(ev.args),
          ...((ev.toolName === "edit" || ev.toolName === "write") && typeof path === "string" ? { writePath: path } : {}),
          state: "running",
          startedAt: Date.now(),
          ...("parentToolCallId" in ev ? { parentToolCallId: ev.parentToolCallId as string } : {}),
        };
        this.toolCalls.push(call);
        if (ev.toolCallId) this.openCalls.set(ev.toolCallId, call);
        break;
      }

      case "tool_execution_end": {
        // SDK ordinary and nested events carry a call ID. Never guess between parallel calls.
        const call = this.openCalls.get(ev.toolCallId) ?? this.toolCalls.find((c) => c.id === ev.toolCallId);
        if (call) {
          if (call.state === "running" && !ev.isError && call.writePath !== undefined) {
            this.currentRun.touchedFiles.add(call.writePath);
            this.currentRun.editWriteCount++;
          }
          call.state = ev.isError ? "error" : "ok";
          call.ms = call.startedAt === undefined ? call.ms ?? 0 : Date.now() - call.startedAt;
          call.result = flatten(ev.result);
          delete call.startedAt;
          this.openCalls.delete(ev.toolCallId);
        }
        break;
      }

      case "auto_retry_start":
        // The retry requests again after its backoff; silence counts from then.
        this.currentRun.awaitingModel = true;
        this.currentRun.retrying = true;
        this.currentRun.lastActivityAt = Date.now() + ev.delayMs;
        // Pi retries transient provider failures itself; record it so a caller can tell a flaky
        // provider from a broken prompt, and switch provider instead of retrying blindly.
        this.notices.push({ type: "warning", at: new Date().toISOString(),
          message: `provider retry ${ev.attempt}/${ev.maxAttempts} in ${ev.delayMs}ms: ${ev.errorMessage}` });
        this.onChange?.();
        break;

      case "auto_retry_end":
        if (!ev.success) this.currentRun.retriesExhausted = ev.attempt;
        break;

      case "message_end":
        // Only the latest assistant message counts, so a turn that recovers after a retry is not failed.
        if (ev.message.role === "assistant") {
          this.currentRun.awaitingModel = false;
          this.currentRun.stopReason = ev.message.stopReason;
          this.currentRun.providerError =
            ev.message.stopReason === "error" ? ev.message.errorMessage || "provider error" : undefined;
          this.lastText = ev.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        }
        break;

      case "message_update":
        if (ev.assistantMessageEvent.type === "text_end" && ev.message.role === "assistant")
          this.lastText = ev.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        break;
    }
  }

  pendingQuestions() {
    return [...this.questions.values()].map((q) => q.toJSON());
  }

  answer(requestId: string, value: string | boolean): { answered: string } {
    const q = this.questions.get(requestId);
    if (!q) throw new Error(`No pending question ${requestId} on session ${this.id}`);
    this.questions.delete(requestId);
    q.resolve(q.kind === "confirm" ? value === true || value === "true" : value);
    this.onChange?.();
    return { answered: requestId };
  }

  async steer(text: string): Promise<{ steered: true; queued: number }> {
    if (this.state !== "running" || !this.session || this.isStopped())
      throw new Error(`Session ${this.id} is ${this.state}, cannot steer` +
        (["done", "aborted", "error"].includes(this.state) ? ". Use follow_up to give a finished session another turn." : "."));
    await this.session.steer(text);
    this.steering = [...this.session.getSteeringMessages()];
    await this.job?.save(this.checkpoint());
    return { steered: true, queued: this.session.getSteeringMessages().length };
  }

  async abort(
    reason: TerminationReason = "manual_abort",
    detail: { limit?: number; observed?: number } = {},
  ): Promise<{ aborted: true; termination: Termination }> {
    const run = this.currentRun;
    // A finished session has nothing to stop, and its recorded state must not change.
    if (!this.isActive && ["done", "error", "aborted"].includes(this.state))
      throw new Error(`Session ${this.id} is already ${this.state}; there is nothing to abort.`);
    if (this.state === "starting") {
      this.clearResult();
      run.touchedFiles.clear();
      run.editWriteCount = 0;
      this.termination = undefined;
      this.finishedAt = undefined;
      this.error = undefined;
    }
    if (!this.termination)
      this.termination = {
        reason,
        ...(detail.limit === undefined ? {} : { limit: detail.limit }),
        ...(detail.observed === undefined ? {} : { observed: detail.observed }),
        at: new Date().toISOString(),
      };
    const termination = this.termination;
    // No model execution took place; later authentication must not move its clock past this end.
    if (this.state === "starting") {
      run.startedAt = termination.at;
      this.finishedAt = termination.at;
    }
    this.state = "aborted";
    // Extension dialogs do not automatically observe the agent's abort signal.
    const session = this.session;
    const job = this.job;
    // Reserve cancellation before checkpointing yields. Even a failed save must drain the SDK.
    run.abortPromise ??= Promise.resolve().then(async () => {
      try { if (job) await job.save(this.checkpoint()); }
      finally { if (this.currentRun === run) await session?.abort().catch(NOOP); }
    }).finally(() => {
      run.abortPromise = undefined;
      if (this.currentRun === run) this.onChange?.();
    });
    this.clearQuestions();
    this.onChange?.();
    await run.abortPromise;
    return { aborted: true, termination };
  }

  /** Timer/event callers cannot await cancellation; retain checkpoint failures as diagnostics. */
  private abortForBudget(reason: "deadline" | "max_turns" | "stalled", detail: { limit: number; observed: number }): void {
    const run = this.currentRun;
    void this.abort(reason, detail).catch((error: unknown) => {
      if (this.currentRun !== run) return;
      this.notices.push({ type: "warning", at: new Date().toISOString(), message: `Budget cancellation failed: ${message(error)}` });
      this.onChange?.();
    });
  }

  /**
   * Take tools away for the final answer. Explicitly renewed follow-ups can restore the grants.
   */
  private lastTurn(session = this.session): void {
    if (!session) return;
    const hadTools = session.getActiveToolNames().length > 0;
    session.setActiveToolsByName([]);
    this.activeTools = [];
    if (hadTools) {
      const budget = this.toolCallsSpent()
        ? `tool-call cap ${this.budgetToolCalls()}/${this.maxToolCalls} (turn ${this.budgetTurns}/${this.maxTurns})`
        : `turn ${this.budgetTurns}/${this.maxTurns}`;
      this.notices.push({ type: "warning", message: `${budget}: tools removed for the last turn`, at: new Date().toISOString() });
    }
  }

  /** Steer once per run toward a final answer, whichever budget gets close first. */
  private requestFinish(budget: string, remaining: string): void {
    const run = this.currentRun;
    if (run.finishSteerSent) return;
    run.finishSteerSent = true;
    this.notices.push({ type: "warning", message: `${budget}: requested wrap-up with only essential checks`, at: new Date().toISOString() });
    void this.session?.steer(`${remaining} ${FINALIZE_PROMPT}`).catch((e: unknown) => {
      if (this.currentRun !== run) return;
      this.notices.push({ type: "warning", message: `automatic finalization steer failed: ${message(e)}`, at: new Date().toISOString() });
    });
  }

  dispose(): void {
    this.currentRun.clearTimers();
    this.unsubscribe?.();
    this.journalUnsubscribe?.();
    const session = this.session;
    if (this.nestedCalls && session) {
      // dispose() does not emit session_shutdown; native transports need that event.
      this.nativeClose ??= session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
        .then(() => {}).finally(() => session.dispose());
      void this.nativeClose.catch(NOOP);
    } else session?.dispose?.();
  }

  /** Elapsed time of the current run, which the wall-clock limit applies to. */
  private elapsedMs(): number {
    const end = this.finishedAt && !this.isActive ? Date.parse(this.finishedAt) : Date.now();
    return end - Date.parse(this.currentRun.startedAt);
  }

  snapshot({ verbose = false, diagnostics = false }: { verbose?: boolean; diagnostics?: boolean } = {}): Snapshot {
    const stats = this.session?.getSessionStats?.();
    const full: Snapshot = {
      sessionId: this.id,
      ...(this.options.forkedFrom ? { forkedFrom: this.options.forkedFrom } : {}),
      label: this.label,
      state: this.state,
      model: this.model,
      thinking: this.thinking,
      cwd: this.cwd,
      activeTools: this.activeTools,
      turns: this.turns,
      toolCalls: this.toolCalls,
      toolCallCount: this.toolCalls.length,
      ...(this.currentRun.editWriteCount ? {
        touchedFiles: [...this.currentRun.touchedFiles], editWriteCount: this.currentRun.editWriteCount,
      } : {}),
      lastText: this.lastText,
      questions: this.pendingQuestions(),
      notices: this.notices,
      error: this.error,
      startedAt: this.startedAt,
      runStartedAt: this.currentRun.startedAt,
      budgetStart: { turns: this.currentRun.budget.turnStart, toolCalls: this.currentRun.budget.toolCallStart },
      finishedAt: this.finishedAt,
      elapsedMs: this.elapsedMs(),
      limits: { maxTurns: this.maxTurns, maxDurationMs: this.maxDurationMs,
        ...(this.maxToolCalls !== undefined ? { maxToolCalls: this.maxToolCalls } : {}) },
      termination: this.termination,
      durable: this.durable,
      retentionDays: this.retentionDays,
      usage: this.usage(stats),
      ...(diagnostics && stats?.contextUsage ? { contextUsage: stats.contextUsage } : {}),
      ...this.answerState(),
      ...(this.saved ?? {}),
      ...(this.reportIndex ? { reportIndex: this.reportIndex } : {}),
      ...(this.reportIndexError ? { reportIndexError: this.reportIndexError } : {}),
      ...this.continuation,
      ...this.liveness(),
    };
    return verbose ? full : compactSnapshot(full);
  }

  /**
   * While running: ms since the last SDK event, and what is being waited on: "model" while a model
   * request is outstanding, "tool" while a tool executes in this process, "agent" while Pi or an
   * extension works in between. Long silence in "model" is slow reasoning or a hung request.
   * Nothing while a question waits for the caller: that is the caller's turn, not a stall.
   */
  private liveness(): { idleMs?: number; phase?: Snapshot["phase"] } {
    if (this.state !== "running" || !this.isActive || this.questions.size > 0) return {};
    return { idleMs: Math.max(0, Date.now() - this.currentRun.lastActivityAt),
      phase: this.currentRun.compacting ? "compaction" : this.openCalls.size > 0 ? "tool" : this.currentRun.awaitingModel ? "model" : "agent" };
  }

  /** Only for a finished run, and only when its final text is not a usable conclusion. */
  private answerState(): { answerState?: "missing" | "partial" | "narration" } {
    // Only for done: an aborted or failed run already says why it has no conclusion. Not gated on
    // isActive: the terminal checkpoint is taken while the run still settles.
    if (this.state !== "done") return {};
    const state = this.lastText.trim() === "" ? "missing" : this.answerFlag;
    return state ? { answerState: state } : {};
  }

  /** Summed from the session's entries, so it survives durable recovery with them. */
  private usage(stats: ReturnType<AgentSession["getSessionStats"]> | undefined): Usage | undefined {
    if (!stats) return undefined;
    const { input, output, cacheRead, cacheWrite, total } = stats.tokens;
    const baseline = this.options.usageBaseline;
    return { input: input - (baseline?.input ?? 0), output: output - (baseline?.output ?? 0),
      cacheRead: cacheRead - (baseline?.cacheRead ?? 0), cacheWrite: cacheWrite - (baseline?.cacheWrite ?? 0),
      totalTokens: total - (baseline?.totalTokens ?? 0), cost: stats.cost - (baseline?.cost ?? 0) };
  }

  /** Keep the finished state readable by any process without loading the session. */
  private recordFinal(): void {
    // Not isActive: an abort may still be draining the SDK when the task has already ended.
    if (this.suspended || !["done", "aborted", "error"].includes(this.state)) return;
    // An abort outside a run (a recovered task already past its budget) never reached the run's
    // own completion stamp.
    this.finishedAt ??= new Date().toISOString();
    this.job?.recordFinal(this.snapshot({ verbose: true }));
  }
}
