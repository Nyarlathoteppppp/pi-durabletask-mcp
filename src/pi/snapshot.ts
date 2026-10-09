import { omitsSavedText } from "../save.js";
import type { Snapshot, ToolCallSummary } from "../types.js";

const RECENT_CALLS = 5;
const COMPACT_ARGS = 120;

/**
 * Polling a delegate must stay cheap for the caller's context: compact snapshots carry only the
 * last few calls, with short arguments, and the newest notices.
 */
export function compactSnapshot(full: Snapshot): Snapshot {
  const trace: ToolCallSummary[] = full.toolCalls.slice(-RECENT_CALLS).map((c) => ({ seq: c.seq, name: c.name,
    state: c.state, ms: c.ms, args: c.args && c.args.length > COMPACT_ARGS ? `${c.args.slice(0, COMPACT_ARGS)}…` : c.args }));
  // A long text written to savedTo is not repeated; verbose still has it.
  const { lastText, contextUsage: _diagnostic, ...rest } = full;
  const boundary = full.runStartedAt ?? full.startedAt;
  const notices = full.notices.filter((n) => n.at >= boundary).slice(-RECENT_CALLS);
  return { ...rest, ...(omitsSavedText(full) ? {} : { lastText }), toolCalls: trace, notices } as Snapshot;
}
