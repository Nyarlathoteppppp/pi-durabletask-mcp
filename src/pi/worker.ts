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
import { DurableJob, forgetOwnedJob, type Checkpoint } from "../durable.js";
import { AGENT_DIR } from "../config.js";
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
} from "../types.js";
import { assertThinkingSupported, resolveModel } from "./models.js";
import { getRuntime } from "./runtime.js";
import { clipArgs, flatten } from "./trace.js";
import { createUiContext, Question } from "./ui.js";

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
  maxTurns: number;
  maxDurationMs: number;
  startedAt?: string;
}

const FINALIZE_PROMPT =
  "Stop expanding the investigation and do not call more tools. Return the best conclusion now from " +
  "the evidence already collected. Include concrete evidence, uncertainty, blockers, and the next action.";

/**
 * One delegated Pi session. The SDK remains live for steering and questions; durable
 * checkpoints retain the conversation and task progress across process restarts.
 */
export class PiWorker {
  readonly id: string;
  readonly label: string | undefined;
  readonly cwd: string;
  readonly toolNames: string[];
  readonly startedAt: string;
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
  run: Promise<void> | undefined;
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
  private deadlineTimer: NodeJS.Timeout | undefined;
  private runTurns = 0;
  private finishSteerSent = false;
  /** pi reports provider failures as an assistant message with stopReason "error", not a throw. */
  private providerError: string | undefined;
  private abortPromise: Promise<void> | undefined;
  private job: DurableJob | undefined;
  recoveryKey: string | undefined;
  private journalUnsubscribe: (() => void) | undefined;
  private suspended = false;
  private recordingStopped = false;
  private settling = false;
  private inputStarted = false;
  private readonly results: Checkpoint["results"] = {};
  private steering: string[] = [];
  private recoveryInput: Checkpoint["recoveryInput"];
  private options: WorkerOptions;

  /** Cancelling a session does not release its concurrency slot until the SDK becomes idle. */
  get isActive(): boolean {
    return this.state === "starting" || this.state === "running" || this.abortPromise !== undefined || this.settling;
  }

  private isStopped(): boolean {
    return this.state === "aborted" || this.suspended;
  }

  private clearQuestions(): void {
    for (const q of this.questions.values()) q.resolve(undefined);
    this.questions.clear();
  }

  constructor({
    id,
    label,
    cwd,
    model,
    thinking,
    tools,
    extensions = false,
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
    this.options = { id: this.id, label, cwd, model, thinking, tools, extensions, nativeMcp, mcpServers: this.mcpServers, maxTurns, maxDurationMs,
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
    this.model = model ? `${model.provider}/${model.id}` : "(pi default)";
    this.thinking = session.thinkingLevel;
    this.activeTools = session.getActiveToolNames();

    this.unsubscribe = session.subscribe((ev) => this.onEvent(ev));
    await session.bindExtensions({ uiContext: this.uiContext(), mode: "rpc" });
    if (this.isStopped()) {
      this.dispose();
      await this.nativeClose;
      return this;
    }
    this.options = { ...this.options, model: this.model, thinking: this.thinking };
    this.job = await DurableJob.open(this.options, prompt, key);
    if (this.isStopped()) {
      await this.job.close();
      this.dispose();
      await this.nativeClose;
      return this;
    }
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
      if (["turn_start", "turn_end", "message_end", "tool_execution_start", "tool_execution_end", "agent_end"].includes(ev.type))
        await this.job!.save(this.checkpoint());
    });
    if (saved && !this.job.needsResume) {
      this.restoreSnapshot(saved);
    } else await this.beginDurable(prompt, saved, Boolean(key));
    return this;
  }

  /** SDK nested events bypass Agent.subscribe; awaited extension hooks persist them. */
  private nativeExecutionJournal(): InlineExtension {
    return { name: "delegate-native-journal", hidden: true, factory: (pi) => {
      pi.on("before_agent_start", () => {
        this.activeTools = pi.getActiveTools();
      });
      pi.on("tool_call", async (ev) => {
        if (this.suspended || !this.job) return { block: true, reason: "Delegate is suspended or has not entered its durable task." };
        // The nested start event has already updated the trace. This hook propagates
        // commit failures (ordinary extension event listeners only report them).
        if (ev.parentToolCallId) await this.job.save(this.checkpoint());
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
        await this.job!.save(this.checkpoint());
      });
    } };
  }

  private clearResults(parentId: string): void {
    delete this.results[parentId];
    for (const [id, result] of Object.entries(this.results)) {
      if (result.parentToolCallId && id.startsWith(`${parentId}/`)) delete this.results[id];
    }
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
    this.state = snapshot.state;
    this.turns = snapshot.turns;
    this.lastText = snapshot.lastText;
    this.error = snapshot.error;
    this.finishedAt = snapshot.finishedAt;
    this.termination = snapshot.termination;
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
    if (saved) this.restoreSnapshot(saved);
    else this.inputStarted = false;
    const alreadyStopped = recover && saved && !["starting", "running"].includes(saved.snapshot.state);
    if (!alreadyStopped) {
      this.state = "running";
      this.finishedAt = undefined;
      this.error = undefined;
      this.termination = undefined;
    }
    this.settling = true;
    const { done } = await this.job!.begin(prompt, this.checkpoint(), async (input, checkpoint, signal) => {
      const suspend = (): void => {
        this.suspended = true;
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
        this.clearQuestions();
        void this.session!.abort();
      };
      signal.addEventListener("abort", suspend, { once: true });
      try {
        if (alreadyStopped) return this.checkpoint();
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
        } else await this.track(this.session!, input);
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
    this.run = done.then(() => {}).catch((error: unknown) => {
      if (this.suspended) return;
      this.state = "error";
      this.error = message(error);
      this.finishedAt = new Date().toISOString();
    }).finally(() => { this.settling = false; this.onChange?.(); });
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
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
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

  async forgetPersistent(): Promise<void> {
    await this.nativeClose;
    if (this.job) await this.job.forget();
    else if (this.recoveryKey) forgetOwnedJob(this.recoveryKey);
  }

  /**
   * Drive one prompt to completion and fold the outcome back into this worker. Shared by
   * `start` and `followUp` so a second turn behaves exactly like the first.
   */
  private track(session: AgentSession, prompt: string): Promise<void> {
    this.state = "running";
    this.error = undefined;
    this.lastText = "";
    this.finishedAt = undefined;
    this.termination = undefined;
    this.runTurns = 0;
    this.finishSteerSent = false;
    this.providerError = undefined;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    const remainingMs = Math.max(1, this.maxDurationMs - this.elapsedMs());
    this.deadlineTimer = setTimeout(() => {
      void this.abort("deadline", { limit: this.maxDurationMs, observed: this.elapsedMs() });
    }, remainingMs);
    const run = session
      .prompt(prompt)
      .then(() => session.waitForIdle())
      .then(() => {
        if (this.state === "aborted" || this.suspended) return;
        if (this.providerError !== undefined) {
          this.state = "error";
          this.error = this.providerError;
        } else this.state = "done";
      })
      .catch((e: unknown) => {
        if (this.state !== "aborted" && !this.suspended) {
          this.state = "error";
          this.error = message(e);
        }
      })
      .finally(() => {
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
        this.deadlineTimer = undefined;
        if (!this.suspended) this.finishedAt = new Date().toISOString();
        // Unblock anything still waiting on an answer that will now never come.
        this.clearQuestions();
        this.onChange?.();
      });
    if (!this.job) this.run = run;
    return run;
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
    if (this.elapsedMs() >= this.maxDurationMs) {
      throw new Error(
        `Session ${this.id} already reached its ${this.maxDurationMs}ms deadline. Spawn a new delegate instead of follow_up.`,
      );
    }
    if (this.job) {
      this.state = "starting";
      return this.beginDurable(prompt).then(() => {
        this.onChange?.();
        return { sessionId: this.id, state: this.state, turnsSoFar: this.turns };
      });
    }
    void this.track(this.session, prompt);
    this.onChange?.();
    return { sessionId: this.id, state: this.state, turnsSoFar: this.turns };
  }

  private onEvent(ev: AgentSessionEvent): void {
    switch (ev.type) {
      case "turn_start":
        this.turns++;
        this.runTurns++;
        this.onChange?.();
        break;

      case "turn_end": {
        // A tool-free turn is normally the final answer. Budget only an agent that is
        // continuing the tool loop, so a conclusion at the limit is not thrown away.
        if (this.state !== "running" || this.suspended || ev.toolResults.length === 0) break;
        if (this.turns >= this.maxTurns) {
          void this.abort("max_turns", { limit: this.maxTurns, observed: this.turns });
          break;
        }
        const finishAt = Math.max(1, Math.floor(this.maxTurns * 0.75));
        if (!this.finishSteerSent && this.turns >= finishAt && this.questions.size === 0) {
          this.finishSteerSent = true;
          this.notices.push({
            type: "warning",
            message: `turn budget ${this.turns}/${this.maxTurns}: requested final answer without more tools`,
            at: new Date().toISOString(),
          });
          void this.session?.steer(FINALIZE_PROMPT).catch((e: unknown) => {
            this.notices.push({
              type: "warning",
              message: `automatic finalization steer failed: ${message(e)}`,
              at: new Date().toISOString(),
            });
          });
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

      case "message_end":
        // Only the latest assistant message counts, so a turn that recovers after a retry is not failed.
        if (ev.message.role === "assistant") {
          this.providerError =
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
      throw new Error(`Session ${this.id} is ${this.state}, cannot steer`);
    await this.session.steer(text);
    this.steering = [...this.session.getSteeringMessages()];
    await this.job?.save(this.checkpoint());
    return { steered: true, queued: this.session.getSteeringMessages().length };
  }

  async abort(
    reason: TerminationReason = "manual_abort",
    detail: { limit?: number; observed?: number } = {},
  ): Promise<{ aborted: true; termination: Termination }> {
    if (!this.termination)
      this.termination = {
        reason,
        ...(detail.limit === undefined ? {} : { limit: detail.limit }),
        ...(detail.observed === undefined ? {} : { observed: detail.observed }),
        at: new Date().toISOString(),
      };
    this.state = "aborted";
    // Extension dialogs do not automatically observe the agent's abort signal.
    this.clearQuestions();
    this.onChange?.();
    if (this.job) await this.job.save(this.checkpoint());
    this.abortPromise ??= (async () => {
      await this.session?.abort().catch(NOOP);
    })().finally(() => {
      this.abortPromise = undefined;
      this.onChange?.();
    });
    await this.abortPromise;
    return { aborted: true, termination: this.termination };
  }

  dispose(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
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

  private elapsedMs(): number {
    return Date.now() - Date.parse(this.startedAt);
  }

  snapshot({ verbose = false }: { verbose?: boolean } = {}): Snapshot {
    const trace: Array<ToolCall | ToolCallSummary> = this.toolCalls.map((c) =>
      verbose ? c : { seq: c.seq, name: c.name, state: c.state, ms: c.ms, args: c.args },
    );
    return {
      sessionId: this.id,
      label: this.label,
      state: this.state,
      model: this.model,
      thinking: this.thinking,
      cwd: this.cwd,
      activeTools: this.activeTools,
      turns: this.turns,
      toolCalls: trace,
      lastText: this.lastText,
      questions: this.pendingQuestions(),
      notices: this.notices,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      elapsedMs: this.elapsedMs(),
      limits: { maxTurns: this.maxTurns, maxDurationMs: this.maxDurationMs },
      termination: this.termination,
    };
  }
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
      const nested = Object.entries(saved.results).filter(([id, value]) => value.parentToolCallId && id.startsWith(`${part.id}/`));
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

/** Errors reach us as `unknown`; this is the one place that decides how to read them. */
export function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
