import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type CreateAgentSessionResult,
  type FileEntry,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { DurableJob, forgetOwnedJob, MemoryJob, releaseJob, type Checkpoint, type JobStore } from "../durable.js";
import { AGENT_DIR, RETENTION_DAYS, STALL_MS } from "../config.js";
import { JUDGE_ENABLED, judgeAnswer } from "../judge.js";
import { saveText } from "../save.js";
import { followUpInfo } from "../continuation.js";
import { secretPathGuard } from "../secrets.js";
import { createProtectedGrepTool } from "./search.js";
import { nativeMcpFactories, validateNativeMcp, type NativeMcpOptions } from "./native-mcp.js";
import type {
  Notice,
  PiThinkingLevel,
  SessionState,
  Snapshot,
  Termination,
  TerminationReason,
  ToolCall,
  ToolCallSummary,
  Usage,
} from "../types.js";
import { assertProviderReady, assertThinkingSupported, resolveModel } from "./models.js";
import { getRuntime } from "./runtime.js";
import { clipArgs, flatten } from "./trace.js";
import { createUiContext, Question } from "./ui.js";
import { WorkerRun } from "./run.js";

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
  /** True saves and recovers the delegate. Default false: memory only, as for MCP callers. */
  durable?: boolean;
  /** Days to keep a finished durable delegate; RETENTION_DAYS when absent. */
  retentionDays?: number | undefined;
  maxTurns: number;
  maxDurationMs: number;
  startedAt?: string;
}

const RECENT_CALLS = 5;
const COMPACT_ARGS = 120;

const LAST_TURN_PROMPT =
  "This is your last turn, and your tools have been removed. Answer now from the evidence already collected. " +
  "Include concrete evidence, uncertainty, blockers, and the next action.";

const FINALIZE_PROMPT =
  "Stop expanding the investigation. Reserve one remaining turn for your final answer; use other " +
  "remaining turns only for essential checks needed to support your conclusion. Return the best conclusion from " +
  "the evidence already collected. Include concrete evidence, uncertainty, blockers, and the next action.";

/**
 * One delegated Pi session. The SDK remains live for steering and questions; durable
 * checkpoints retain the conversation and task progress across process restarts.
 * Event ordering and completion rules: docs/worker-lifecycle.md.
 */
export class PiWorker {
  readonly id: string;
  readonly label: string | undefined;
  readonly cwd: string;
  readonly toolNames: string[];
  readonly startedAt: string;
  /**
   * Control state of the current spawn or follow_up. The wall-clock limit applies
   * per run, so a session can be continued days later; turns stay cumulative. Downtime during a
   * run still counts, since recovery keeps this value.
   */
  private currentRun: WorkerRun;
  readonly maxTurns: number;
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
    return followUpInfo(this.state, this.turns, this.maxTurns,
      this.isActive ? (["starting", "running"].includes(this.state) ? "running" : "finalizing")
        : !this.session ? "not_started" : undefined);
  }

  private isStopped(): boolean {
    return this.state === "aborted" || this.suspended;
  }

  private clearQuestions(): void {
    for (const q of this.questions.values()) q.resolve(undefined);
    this.questions.clear();
  }

  private newRun(): WorkerRun {
    this.currentRun.clearTimers();
    this.answerFlag = undefined;
    this.saved = undefined;
    return this.currentRun = new WorkerRun(this.currentRun.startedAt);
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
    startedAt,
  }: WorkerOptions) {
    this.id = id ?? randomUUID();
    this.label = label;
    this.cwd = cwd;
    this.modelSpec = model;
    this.thinkingSpec = thinking;
    this.toolNames = tools;
    this.extensionsEnabled = extensions;
    this.nativeMcp = nativeMcp;
    this.mcpServers = [...mcpServers];
    this.maxTurns = maxTurns;
    this.maxDurationMs = maxDurationMs;
    this.startedAt = startedAt ?? new Date().toISOString();
    this.currentRun = new WorkerRun(this.startedAt);
    this.options = { id: this.id, label, cwd, model, thinking, tools, extensions, durable, retentionDays, nativeMcp, mcpServers: this.mcpServers, maxTurns, maxDurationMs,
      startedAt: this.startedAt };
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

  async start(prompt: string, saved?: Checkpoint, key?: string): Promise<this> {
    validateNativeMcp(this.options, this.cwd);
    const model = await resolveModel(this.modelSpec, this.cwd);
    if (this.isStopped()) return this;

    assertThinkingSupported(model, this.thinkingSpec);

    // Third-party pi extensions start timers and sockets that outlive dispose() and then
    // throw against a stale ctx. A delegate does not need them.
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: AGENT_DIR,
      noExtensions: !this.extensionsEnabled,
      noSkills: true,
      noContextFiles: true,
      extensionFactories: [secretPathGuard(this.cwd),
        ...(this.nativeMcp && this.toolNames.length ? nativeMcpFactories(this.cwd, this.mcpServers) : []),
        ...(this.nativeMcp ? [this.nativeExecutionJournal()] : [])],
    });

    // The loader is lazy: getExtensions() returns nothing until reload() has run.
    // Always reload so the inline secret-path guard is installed even when third-party
    // extensions stay off. Failure must not leave the secret guard uninstalled.
    await resourceLoader.reload();
    if (this.isStopped()) return this;

    const { session } = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: await getRuntime(),
      model,
      thinkingLevel: this.thinkingSpec,
      sessionManager: SessionManager.inMemory(this.cwd, undefined, saved ? repairEntries(saved) : undefined),
      tools: this.toolNames,
      customTools: this.toolNames.includes("grep") ? [defineTool(createProtectedGrepTool(this.cwd))] : [],
      resourceLoader,
    });
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
    if (this.isStopped()) {
      this.dispose();
      await this.nativeClose;
      return this;
    }
    this.options = { ...this.options, model: chosen ? this.model : undefined, thinking: this.thinking };
    this.job = this.options.durable === false ? new MemoryJob() : await DurableJob.open(this.options, prompt, key);
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

  /** SDK nested events bypass Agent.subscribe; awaited extension hooks persist them. */
  private nativeExecutionJournal(): InlineExtension {
    return { name: "delegate-native-journal", hidden: true, factory: (pi) => {
      pi.on("before_agent_start", () => {
        this.activeTools = pi.getActiveTools();
      });
      pi.on("context_with_system", (event) => {
        if (this.turns < this.maxTurns) return;
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
    this.state = snapshot.state;
    this.turns = snapshot.turns;
    this.lastText = snapshot.lastText;
    this.error = snapshot.error;
    this.finishedAt = snapshot.finishedAt;
    this.termination = snapshot.termination;
    this.answerFlag = snapshot.answerState === "missing" ? undefined : snapshot.answerState;
    this.saved = snapshot.savedTo ? { savedTo: snapshot.savedTo, savedChars: snapshot.savedChars ?? 0 }
      : snapshot.saveError ? { saveError: snapshot.saveError } : undefined;
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

  private async beginDurable(prompt: string, saved?: Checkpoint, recover = false): Promise<void> {
    const run = this.newRun();
    if (saved) this.restoreSnapshot(saved);
    else this.inputStarted = false;
    const alreadyStopped = recover && saved && !["starting", "running"].includes(saved.snapshot.state);
    // Check credentials only when this run will call the model: spawn, follow_up, or a recovery
    // that still has work. A recovery that only records an answer already given must not fail
    // because a provider's auth broke meanwhile.
    const answered = recover && saved?.inputStarted && !this.steering.length &&
      this.session!.messages.at(-1)?.role === "assistant" &&
      (this.session!.messages.at(-1) as { stopReason?: string }).stopReason === "stop";
    // A recovery already past its budget is only marked aborted, so it needs no model either.
    const overBudget = recover && (this.turns >= this.maxTurns || this.elapsedMs() >= this.maxDurationMs);
    const provider = this.model?.includes("/") ? this.model.slice(0, this.model.indexOf("/")) : undefined;
    if (!alreadyStopped && !answered && !overBudget && provider) {
      try { await assertProviderReady(provider); }
      catch (error) { if (this.currentRun === run && !this.isStopped()) throw error; }
    }
    // Authentication may refresh OAuth over the network. An abort or shutdown received during
    // that await still wins; cancelled runs commit their terminal state without prompting Pi.
    // An abort during that await also lets a new follow_up start; this execution is then superseded.
    if (this.suspended || this.currentRun !== run) return;
    if (!recover) this.currentRun.startedAt = new Date().toISOString();
    if (!alreadyStopped && this.state !== "aborted") {
      this.state = "running";
      this.finishedAt = undefined;
      this.error = undefined;
      this.termination = undefined;
    }
    run.settling = true;
    try {
      const { done } = await this.job!.begin(prompt, this.checkpoint(), async (input, checkpoint, signal) => {
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
          if (alreadyStopped || this.state === "aborted") return this.checkpoint();
          if (recover && checkpoint.inputStarted) {
            const last = this.session!.messages.at(-1);
            if (last?.role === "assistant" && last.stopReason === "stop" && !this.steering.length) {
              this.state = "done";
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
          if (this.turns >= this.maxTurns || this.elapsedMs() >= this.maxDurationMs) {
            await this.abort(this.turns >= this.maxTurns ? "max_turns" : "deadline");
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
      throw error;
    }
  }

  static async recover(options: WorkerOptions, prompt: string, key: string, worker = new PiWorker(options)): Promise<PiWorker> {
    // Read without scheduling. The journal is closed before start reopens it as executor.
    const job = await DurableJob.open(options, prompt, key);
    let saved: Checkpoint | undefined;
    try { saved = await job.saved(); }
    finally { await job.close(false); }
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
    await this.nativeClose;
    if (this.job) await this.job.close();
    else if (this.recoveryKey) releaseJob(this.recoveryKey);
  }

  async forgetPersistent(): Promise<void> {
    await this.nativeClose;
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
    this.lastText = "";
    this.finishedAt = undefined;
    this.termination = undefined;
    run.prompt = prompt;
    run.lastActivityAt = Date.now();
    // A run with one turn left, or a session with maxTurns 1, has only its answer turn.
    if (this.turns >= this.maxTurns - 1) this.lastTurn(session);
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
  followUp(prompt: string): { sessionId: string; state: SessionState; turnsSoFar: number } | Promise<{ sessionId: string; state: SessionState; turnsSoFar: number }> {
    if (!this.session) throw new Error(`Session ${this.id} never started, nothing to follow up on.`);
    if (this.isActive)
      throw new Error(
        `Session ${this.id} is ${this.state}. Use \`steer\` to redirect a delegate that is still working.`,
      );
    if (this.turns >= this.maxTurns) {
      throw new Error(
        `Session ${this.id} already used ${this.turns}/${this.maxTurns} turns. Spawn a new delegate instead of follow_up.`,
      );
    }
    if (this.job) {
      const previous = this.state;
      this.state = "starting";
      const starting = this.beginDurable(prompt);
      const run = this.currentRun;
      return starting.then(() => {
        if (this.currentRun === run) this.onChange?.();
        return { sessionId: this.id, state: this.state, turnsSoFar: this.turns };
      }, (error: unknown) => {
        // Refused before anything ran (for example, a provider whose credentials fail).
        if (this.currentRun === run) { this.state = previous; this.onChange?.(); }
        throw error;
      });
    }
    void this.track(this.session, prompt);
    this.onChange?.();
    return { sessionId: this.id, state: this.state, turnsSoFar: this.turns };
  }

  private onEvent(ev: AgentSessionEvent): void {
    this.currentRun.lastActivityAt = Date.now();
    switch (ev.type) {
      case "turn_start":
        this.currentRun.awaitingModel = true;
        this.turns++;
        this.onChange?.();
        break;

      case "turn_end": {
        // A tool-free turn is normally the final answer. Budget only an agent that is
        // continuing the tool loop, so a conclusion at the limit is not thrown away.
        if (this.state !== "running" || this.suspended || ev.toolResults.length === 0) break;
        if (this.turns >= this.maxTurns) {
          this.abortForBudget("max_turns", { limit: this.maxTurns, observed: this.turns });
          break;
        }
        // The last turn gets no tools, so the model answers instead of being cut off at the limit.
        if (this.turns === this.maxTurns - 1) {
          this.lastTurn();
          void this.session?.steer(LAST_TURN_PROMPT).catch((e: unknown) => {
            this.notices.push({ type: "warning", message: `last-turn steer failed: ${message(e)}`, at: new Date().toISOString() });
          });
          break;
        }
        const finishAt = Math.max(1, Math.floor(this.maxTurns * 0.75));
        if (this.questions.size > 0) break;
        if (this.turns >= finishAt)
          this.requestFinish(`turn budget ${this.turns}/${this.maxTurns}`,
            `You have ${this.maxTurns - this.turns} turns left, including your final answer.`);
        else if (this.currentRun.timeShort) {
          const left = Math.max(1, Math.round((this.maxDurationMs - this.elapsedMs()) / 1000));
          this.requestFinish(`time budget ${Math.round(this.elapsedMs() / 1000)}s/${Math.round(this.maxDurationMs / 1000)}s`,
            `About ${left} seconds remain before the hard deadline, including your final answer.`);
        }
        break;
      }

      case "tool_execution_start": {
        if (ev.toolCallId && this.toolCalls.some((call) => call.id === ev.toolCallId)) break;
        const call: ToolCall = {
          seq: this.toolCalls.length + 1,
          id: ev.toolCallId,
          name: ev.toolName,
          args: clipArgs(ev.args),
          state: "running",
          startedAt: Date.now(),
          ...("parentToolCallId" in ev ? { parentToolCallId: ev.parentToolCallId as string } : {}),
        };
        this.toolCalls.push(call);
        if (ev.toolCallId) this.openCalls.set(ev.toolCallId, call);
        break;
      }

      case "tool_execution_end": {
        // pi does not always echo the call id back, so fall back to the newest open call
        // of the same name rather than losing the timing entirely.
        const call =
          (ev.toolCallId ? this.openCalls.get(ev.toolCallId) ?? this.toolCalls.find((c) => c.id === ev.toolCallId) : undefined) ??
          [...this.toolCalls].reverse().find((c) => c.state === "running" && c.name === ev.toolName);
        if (call) {
          call.state = ev.isError ? "error" : "ok";
          call.ms = call.startedAt === undefined ? call.ms ?? 0 : Date.now() - call.startedAt;
          call.result = flatten(ev.result);
          delete call.startedAt;
          if (ev.toolCallId) this.openCalls.delete(ev.toolCallId);
        }
        break;
      }

      case "auto_retry_start":
        // The retry requests again after its backoff; silence counts from then.
        this.currentRun.awaitingModel = true;
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
    if (!this.termination)
      this.termination = {
        reason,
        ...(detail.limit === undefined ? {} : { limit: detail.limit }),
        ...(detail.observed === undefined ? {} : { observed: detail.observed }),
        at: new Date().toISOString(),
      };
    const termination = this.termination;
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
   * Take the tools away for the session's last turn. Turns are counted across follow_up, so no
   * later run of this session can use tools again; nothing needs restoring.
   */
  private lastTurn(session = this.session): void {
    if (!session) return;
    const hadTools = session.getActiveToolNames().length > 0;
    session.setActiveToolsByName([]);
    this.activeTools = [];
    if (hadTools) this.notices.push({ type: "warning", message: `turn ${this.turns}/${this.maxTurns}: tools removed for the last turn`, at: new Date().toISOString() });
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
    if (this.nativeMcp && session) {
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

  snapshot({ verbose = false }: { verbose?: boolean } = {}): Snapshot {
    const full: Snapshot = {
      sessionId: this.id,
      label: this.label,
      state: this.state,
      model: this.model,
      thinking: this.thinking,
      cwd: this.cwd,
      activeTools: this.activeTools,
      turns: this.turns,
      toolCalls: this.toolCalls,
      toolCallCount: this.toolCalls.length,
      lastText: this.lastText,
      questions: this.pendingQuestions(),
      notices: this.notices,
      error: this.error,
      startedAt: this.startedAt,
      runStartedAt: this.currentRun.startedAt,
      finishedAt: this.finishedAt,
      elapsedMs: this.elapsedMs(),
      limits: { maxTurns: this.maxTurns, maxDurationMs: this.maxDurationMs },
      termination: this.termination,
      durable: this.durable,
      retentionDays: this.retentionDays,
      usage: this.usage(),
      ...this.answerState(),
      ...(this.saved ?? {}),
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
  private liveness(): { idleMs?: number; phase?: "model" | "tool" | "agent" } {
    if (this.state !== "running" || !this.isActive || this.questions.size > 0) return {};
    return { idleMs: Math.max(0, Date.now() - this.currentRun.lastActivityAt),
      phase: this.openCalls.size > 0 ? "tool" : this.currentRun.awaitingModel ? "model" : "agent" };
  }

  /** Only for a finished run, and only when its final text is not a usable conclusion. */
  private answerState(): { answerState?: "missing" | "partial" | "narration" } {
    // Not gated on isActive: the terminal checkpoint is taken while the run still settles.
    if (!["done", "aborted", "error"].includes(this.state)) return {};
    const state = this.lastText.trim() === "" ? "missing" : this.answerFlag;
    return state ? { answerState: state } : {};
  }

  /** Summed from the session's entries, so it survives durable recovery with them. */
  private usage(): Usage | undefined {
    const stats = this.session?.getSessionStats?.();
    if (!stats) return undefined;
    const { input, output, cacheRead, cacheWrite, total } = stats.tokens;
    return { input, output, cacheRead, cacheWrite, totalTokens: total, cost: stats.cost };
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

/**
 * Polling a delegate must stay cheap for the caller's context: compact snapshots carry only the
 * last few calls, with short arguments, and the newest notices.
 */
export function compactSnapshot(full: Snapshot): Snapshot {
  const trace: ToolCallSummary[] = full.toolCalls.slice(-RECENT_CALLS).map((c) => ({ seq: c.seq, name: c.name,
    state: c.state, ms: c.ms, args: c.args && c.args.length > COMPACT_ARGS ? `${c.args.slice(0, COMPACT_ARGS)}…` : c.args }));
  // A text written to savedTo is not repeated; verbose still has it.
  const { lastText, ...rest } = full;
  return { ...(full.savedTo ? rest : full), toolCalls: trace, notices: full.notices.slice(-RECENT_CALLS) } as Snapshot;
}

/** Match committed results to calls; never blindly replay an interrupted side effect. */
export function repairEntries(saved: Checkpoint): FileEntry[] {
  const manager = SessionManager.inMemory(saved.snapshot.cwd, undefined, saved.entries);
  const messages = manager.buildSessionContext().messages;
  const answered = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall" || answered.has(part.id)) continue;
      const result = saved.results[part.id];
      const nested = nestedResults(saved.results, saved.snapshot.toolCalls, part.id);
      const unknown = "Interrupted by MCP service restart. Execution outcome is unknown; inspect external state before retrying." +
        (nested.length ? "\nCommitted nested tool results (do not replay the interrupted script):\n" +
          JSON.stringify(nested.map(([id, value]) => ({ id, ...value }))) : "");
      manager.appendMessage({ role: "toolResult", toolCallId: part.id, toolName: part.name,
        content: result ? result.content as never : [{ type: "text", text:
          unknown }],
        details: result?.details as never, isError: result?.isError ?? true, timestamp: Date.now() });
      answered.add(part.id);
    }
  }
  return [manager.getHeader()!, ...manager.getEntries()];
}

/** SDK calls can nest again; the trace retains parents whose result is still pending. */
function nestedResults(results: Checkpoint["results"], calls: Snapshot["toolCalls"], parentId: string) {
  const children = new Map<string, Set<string>>();
  const add = (id: string, parent: string): void => {
    let siblings = children.get(parent);
    if (!siblings) children.set(parent, siblings = new Set());
    siblings.add(id);
  };
  for (const call of calls) {
    if ("id" in call && call.id && call.parentToolCallId) add(call.id, call.parentToolCallId);
  }
  for (const [id, result] of Object.entries(results)) {
    if (result.parentToolCallId) add(id, result.parentToolCallId);
  }
  const descendants = new Set([parentId]);
  for (const id of descendants) {
    for (const child of children.get(id) ?? []) descendants.add(child);
  }
  return Object.entries(results).filter(([id]) => id !== parentId && descendants.has(id));
}

/** Errors reach us as `unknown`; this is the one place that decides how to read them. */
export function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
