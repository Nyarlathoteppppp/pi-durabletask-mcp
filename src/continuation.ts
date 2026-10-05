/** State and turn-budget readiness; ownership, capacity and provider auth are checked on launch. */
export interface FollowUpInfo {
  remainingTurns?: number;
  canFollowUp: boolean;
  followUpBlockedReason?: "running" | "finalizing" | "turn_budget_exhausted" | "not_started" | "status_required";
}

export function followUpInfo(
  state: string, turns: number, maxTurns: number,
  blocked?: FollowUpInfo["followUpBlockedReason"],
): FollowUpInfo {
  const remainingTurns = Math.max(0, maxTurns - turns);
  const reason = blocked ?? (state === "starting" || state === "running" ? "running"
    : remainingTurns === 0 ? "turn_budget_exhausted" : undefined);
  return { remainingTurns, canFollowUp: reason === undefined,
    ...(reason ? { followUpBlockedReason: reason } : {}) };
}
