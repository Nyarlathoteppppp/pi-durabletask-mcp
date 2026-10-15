import type { Snapshot } from "../types.js";
import type { WaitSummary } from "../core.js";
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

const FINISHED = new Set(["done", "aborted", "error"]);

/**
 * Compact result collection for run and wait; status remains the diagnostic view. While a run goes
 * on, a poll shows what changed: notices raised since `since` (the start of this wait), and no
 * follow-up fields that only say it is still running.
 */
export function waitResult(snapshot: Snapshot, verbose?: boolean, since?: string) {
  if (verbose) return withNextAction(snapshot);
  const { sessionId, forkedFrom, label, state, turns, toolCallCount, lastText, questions, notices, error, termination, usage,
    remainingTurns, canFollowUp, followUpBlockedReason, idleMs, phase, answerState, savedTo, savedChars, saveError,
    touchedFiles, editWriteCount, reportIndex, reportIndexError, preview, runningElsewhere, salvagedText } = snapshot;
  const finished = FINISHED.has(state);
  const visibleNotices = finished ? notices : notices.filter((n) => n.type !== "info" && (since === undefined || n.at >= since));
  return withNextAction({ sessionId, ...(forkedFrom ? { forkedFrom } : {}), label, state, turns, toolCallCount,
    // A long text the caller asked to have saved is not returned again; it is in savedTo, and preview shows its start.
    ...(savedTo ? { savedTo, savedChars } : {}), ...(finished && !omitsSavedText(snapshot) ? { lastText } : {}),
    ...(finished && preview ? { preview } : {}), ...(salvagedText ? { salvagedText } : {}), ...(saveError ? { saveError } : {}),
    ...(answerState ? { answerState } : {}), questions, notices: visibleNotices, error, termination,
    ...(editWriteCount ? { touchedFiles, editWriteCount } : {}),
    ...(reportIndex ? { reportIndex } : {}), ...(reportIndexError ? { reportIndexError } : {}),
    remainingTurns, ...(finished ? { canFollowUp, ...(followUpBlockedReason ? { followUpBlockedReason } : {}) } : {}),
    ...(runningElsewhere ? { runningElsewhere } : {}),
    ...(finished && usage ? { usage } : {}), ...(idleMs !== undefined ? { idleMs, phase } : {}) });
}

/** A batch summary as a poll shows it: the same rules as waitResult, and no zero question count. */
export function pollSummary<T extends WaitSummary & { nextAction: NextAction }>(summary: T, since: string): Partial<T> {
  const { canFollowUp, followUpBlockedReason, pendingQuestions, notices, ...rest } = summary;
  const finished = FINISHED.has(summary.state);
  const fresh = finished ? notices : notices?.filter((n) => n.at >= since);
  return { ...rest, ...(pendingQuestions ? { pendingQuestions } : {}), ...(fresh?.length ? { notices: fresh } : {}),
    ...(finished ? { canFollowUp, ...(followUpBlockedReason ? { followUpBlockedReason } : {}) } : {}) } as Partial<T>;
}

/** Every tool answers with compact JSON: the calling model reads it, and indentation costs it tokens on every call. */
export const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
