/** Every state a delegate can be in. `starting` covers session construction. */
export type SessionState = "starting" | "running" | "done" | "aborted" | "error";

export type TerminationReason =
  | "manual_abort"
  | "caller_cancelled"
  | "max_turns"
  | "deadline"
  | "server_shutdown";

export interface Termination {
  reason: TerminationReason;
  limit?: number;
  observed?: number;
  at: string;
}

/** Thinking levels accepted by pi 0.84.x. Omit the field to let pi apply its own settings. */
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type QuestionKind = "select" | "confirm" | "input";

export interface QuestionJson {
  id: string;
  kind: QuestionKind;
  title: string;
  detail: string | undefined;
  options: string[] | undefined;
  asked: string;
}

export interface Notice {
  type: string;
  message: string;
  at: string;
}

/** One entry in the ordered trace of tools a delegate ran. */
export interface ToolCall {
  parentToolCallId?: string;
  seq: number;
  id: string | undefined;
  name: string;
  args: string | undefined;
  state: "running" | "ok" | "error";
  ms?: number;
  result?: string | undefined;
  /** Present only while the call is open; stripped once it ends. */
  startedAt?: number;
}

/** The compact trace shape, used unless `verbose` is asked for. */
export type ToolCallSummary = Pick<ToolCall, "seq" | "name" | "state" | "ms" | "args">;

export interface Snapshot {
  sessionId: string;
  label: string | undefined;
  state: SessionState;
  model: string | undefined;
  thinking: PiThinkingLevel | undefined;
  cwd: string;
  activeTools: string[] | undefined;
  turns: number;
  /** Every call when verbose; otherwise the most recent few. `toolCallCount` is the total. */
  toolCalls: Array<ToolCall | ToolCallSummary>;
  toolCallCount: number;
  lastText: string;
  questions: QuestionJson[];
  notices: Notice[];
  error: string | undefined;
  startedAt: string;
  /** Start of the current run (spawn or latest follow_up); the wall-clock limit applies from here. */
  runStartedAt?: string;
  finishedAt: string | undefined;
  elapsedMs: number;
  limits: { maxTurns: number; maxDurationMs: number };
  termination: Termination | undefined;
  /** False: in memory only, gone when this MCP process exits. */
  durable: boolean;
  /** Days kept on disk after finishing; absent for non-durable delegates. */
  retentionDays?: number | undefined;
  /** Tokens and cost of the whole session so far, across follow_up; cost uses pi's model prices. */
  usage?: Usage | undefined;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

/** pi's enabledModels scope, resolved for one working directory. */
export interface ModelScope {
  enabled: Set<string>;
  customProviders: Set<string>;
}

/** One delegate as written to the status line state file. */
export interface PublishedSession {
  id: string;
  label: string | undefined;
  state: SessionState;
  model: string | undefined;
  thinking: PiThinkingLevel | undefined;
  cwd: string;
  turns: number;
  questions: number;
  startedAt: string;
}

export interface StateFile {
  pid: number;
  hostPid: number | undefined;
  updatedAt: string;
  sessions: PublishedSession[];
}
