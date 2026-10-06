/** Transient control state for one spawn/follow-up. The worker owns the conversation and journal. */
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
  /** Last SDK event of this run (stream deltas included); silence beyond it is idleMs. */
  lastActivityAt = Date.now();
  /** A model request is outstanding: from turn_start to the assistant's message_end. */
  awaitingModel = false;
  /** This run's prompt and its last assistant message's stop reason, for answerState. */
  prompt = "";
  stopReason: string | undefined;

  constructor(public startedAt: string) {}

  clearTimers(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.finishTimer) clearTimeout(this.finishTimer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.deadlineTimer = this.finishTimer = this.stallTimer = undefined;
  }
}
