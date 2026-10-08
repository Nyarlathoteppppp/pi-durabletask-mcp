export interface FollowUpBudget {
  maxTurns?: number;
  maxToolCalls?: number;
}

/** Quotas and cumulative counters at their most recent explicit renewal. */
export interface RunBudget {
  maxTurns: number;
  maxToolCalls?: number;
  turnStart: number;
  toolCallStart: number;
}

/** Control state for one spawn/follow-up. The worker owns the conversation and journal. */
export class WorkerRun {
  deadlineTimer: NodeJS.Timeout | undefined;
  finishTimer: NodeJS.Timeout | undefined;
  stallTimer: NodeJS.Timeout | undefined;
  finishSteerSent = false;
  /** Request wrap-up after the next tool turn once 2/3 of this run's time is spent. */
  timeShort = false;
  providerError: string | undefined;
  retriesExhausted: number | undefined;
  abortPromise: Promise<void> | undefined;
  completion: Promise<void> | undefined;
  settling = false;
  /** Re-enable the original grants only after a renewed task has been created. */
  restoreTools = false;
  /** Last SDK event of this run (stream deltas included); silence beyond it is idleMs. */
  lastActivityAt = Date.now();
  /** A model request is outstanding: from turn_start to the assistant's message_end. */
  awaitingModel = false;
  /** SDK context summarization, distinct from a delegate model request. */
  compacting = false;
  /** An automatic retry is pending: its turn_start repeats the failed turn, not a new one. */
  retrying = false;
  /** This run's prompt and its last assistant message's stop reason, for answerState. */
  prompt = "";
  stopReason: string | undefined;
  /** Successful edit/write events in this run; paths are the original tool arguments. */
  touchedFiles = new Set<string>();
  editWriteCount = 0;

  constructor(public startedAt: string, public budget: RunBudget) {}

  clearTimers(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.finishTimer) clearTimeout(this.finishTimer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.deadlineTimer = this.finishTimer = this.stallTimer = undefined;
  }
}
