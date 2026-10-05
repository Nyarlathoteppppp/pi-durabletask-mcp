/** Transient control state for one spawn/follow-up. The worker owns the conversation and journal. */
export class WorkerRun {
  deadlineTimer: NodeJS.Timeout | undefined;
  finishTimer: NodeJS.Timeout | undefined;
  finishSteerSent = false;
  /** Request wrap-up after the next tool turn once 2/3 of this run's time is spent. */
  timeShort = false;
  providerError: string | undefined;
  retriesExhausted: number | undefined;
  abortPromise: Promise<void> | undefined;
  completion: Promise<void> | undefined;
  settling = false;

  constructor(public startedAt: string) {}

  clearTimers(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.deadlineTimer = this.finishTimer = undefined;
  }
}
