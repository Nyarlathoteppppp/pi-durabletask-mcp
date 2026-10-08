/** Descriptive result schemas for Codemode declarations; execution does not validate outputs. */
import { z } from "zod";

const state = z.enum(["starting", "running", "done", "aborted", "error"]);
const nextAction = z.enum(["wait", "answer", "finish"]);
const question = z.object({
  id: z.string(), kind: z.enum(["select", "confirm", "input"]), title: z.string(),
  detail: z.string().optional(), options: z.array(z.string()).optional(), asked: z.string(),
});
const usage = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(),
  cacheWrite: z.number(), totalTokens: z.number(), cost: z.number() });
const termination = z.object({
  reason: z.enum(["manual_abort", "caller_cancelled", "max_turns", "deadline", "stalled", "server_shutdown"]),
  at: z.string(), limit: z.number().optional(), observed: z.number().optional(),
});
const publication = { reportIndex: z.string().optional(), reportIndexError: z.string().optional() };
const continuation = {
  remainingTurns: z.number().optional(), canFollowUp: z.boolean(),
  followUpBlockedReason: z.enum(["running", "finalizing", "turn_budget_exhausted", "not_started", "status_required", "cleanup_failed"]).optional(),
};
const report = {
  sessionId: z.string(), label: z.string().optional(), state,
  error: z.string().optional(), termination: termination.optional(), usage: usage.optional(),
  answerState: z.enum(["missing", "partial", "narration"]).optional(),
  savedTo: z.string().optional(), savedChars: z.number().optional(), saveError: z.string().optional(),
  ...continuation, nextAction,
};

export const coordinatorOutputs = {
  delegate_start_batch: z.object({
    requested: z.number(), started: z.number(), sessionIds: z.array(z.string()),
    sessions: z.array(z.object({
      index: z.number(), taskIndex: z.number(), sessionId: z.string(), state,
      label: z.string().optional(), model: z.string().optional(), thinking: z.string().optional(),
      forkedFrom: z.string().optional(), limits: z.object({ maxTurns: z.number(), maxDurationMs: z.number() }),
    })),
    failed: z.number().optional(),
    failures: z.array(z.object({ index: z.number(), taskIndex: z.number(), id: z.string().optional(), error: z.string() })).optional(),
    ...publication,
  }),
  delegate_wait: z.object({
    settled: z.array(z.string()), pending: z.array(z.string()), continueIds: z.array(z.string()),
    sessions: z.array(z.object({
      ...report, turns: z.number(), toolCallCount: z.number(), pendingQuestions: z.number(),
      questions: z.array(question).optional(), forkedFrom: z.string().optional(),
      touchedFiles: z.array(z.string()).optional(), editWriteCount: z.number().optional(),
      notices: z.array(z.object({ type: z.string(), message: z.string(), at: z.string() })).optional(),
      idleMs: z.number().optional(), phase: z.enum(["model", "tool", "agent", "compaction"]).optional(),
      ...publication,
    })),
    nextAction, ...publication,
  }),
  delegate_get: z.object({ ...report, lastText: z.string(), questions: z.array(question), ...publication }),
  delegate_follow_up: z.object({
    sessionId: z.string(), state, turnsSoFar: z.number(), next: z.string().optional(),
    nextAction: z.literal("wait"), ...publication,
  }),
};
