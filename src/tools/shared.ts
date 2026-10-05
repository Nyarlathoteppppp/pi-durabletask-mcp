import type { Snapshot } from "../types.js";

export type NextAction = "wait" | "answer" | "finish";

/** Advice for the calling agent, not an execution-state transition. */
export function nextAction(state: string, pendingQuestions = 0): NextAction {
  if (state === "done" || state === "aborted" || state === "error") return "finish";
  return pendingQuestions > 0 ? "answer" : "wait";
}

export function withNextAction<T extends {
  state: string; questions?: readonly unknown[]; pendingQuestions?: number;
}>(value: T): T & { nextAction: NextAction } {
  return { ...value, nextAction: nextAction(value.state, value.questions?.length ?? value.pendingQuestions ?? 0) };
}

/** Answer questions first, then keep collecting any executions that are still active. */
export function batchNextAction(sessions: Array<{ nextAction: NextAction }>): NextAction {
  return sessions.some((s) => s.nextAction === "answer") ? "answer"
    : sessions.some((s) => s.nextAction === "wait") ? "wait" : "finish";
}

/** Compact result collection for run and wait; status remains the diagnostic view. */
export function waitResult(snapshot: Snapshot, verbose?: boolean) {
  if (verbose) return withNextAction(snapshot);
  const { sessionId, label, state, turns, toolCallCount, lastText, questions, notices, error, termination, usage,
    remainingTurns, canFollowUp, followUpBlockedReason } = snapshot;
  const finished = state === "done" || state === "aborted" || state === "error";
  return withNextAction({ sessionId, label, state, turns, toolCallCount, lastText, questions, notices, error, termination,
    remainingTurns, canFollowUp, ...(followUpBlockedReason ? { followUpBlockedReason } : {}),
    ...(finished && usage ? { usage } : {}) });
}

/** Every tool answers with pretty JSON, so a human reading the transcript can follow it. */
export const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
