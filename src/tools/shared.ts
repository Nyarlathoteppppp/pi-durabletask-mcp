import type { Snapshot } from "../types.js";
import { omitsSavedText } from "../save.js";

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
  const { sessionId, forkedFrom, label, state, turns, toolCallCount, lastText, questions, notices, error, termination, usage,
    remainingTurns, canFollowUp, followUpBlockedReason, idleMs, phase, answerState, savedTo, savedChars, saveError,
    touchedFiles, editWriteCount } = snapshot;
  const finished = state === "done" || state === "aborted" || state === "error";
  return withNextAction({ sessionId, ...(forkedFrom ? { forkedFrom } : {}), label, state, turns, toolCallCount,
    // A long text the caller asked to have saved is not returned again; it is in savedTo.
    ...(savedTo ? { savedTo, savedChars } : {}), ...(omitsSavedText(snapshot) ? {} : { lastText }), ...(saveError ? { saveError } : {}),
    ...(answerState ? { answerState } : {}), questions, notices, error, termination,
    ...(editWriteCount ? { touchedFiles, editWriteCount } : {}),
    remainingTurns, canFollowUp, ...(followUpBlockedReason ? { followUpBlockedReason } : {}),
    ...(finished && usage ? { usage } : {}), ...(idleMs !== undefined ? { idleMs, phase } : {}) });
}

/** Every tool answers with pretty JSON, so a human reading the transcript can follow it. */
export const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
