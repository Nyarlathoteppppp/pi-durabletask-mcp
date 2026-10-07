# Caller-planned codemode coordination

A main agent supplies a plan; one Pi coordinator dispatches, waits and synthesizes
using JavaScript loops/conditions. It shares the existing execution core with ordinary
MCP tools. Original child reports remain available by session ID and saved file.

Enable `codemode` in `PI_DELEGATE_ALLOW_TOOLS`. Start the coordinator with `spawn`
(or `run`; batch tasks can also carry `coordinator`):

```json
{
  "cwd": "/absolute/repo",
  "tools": ["codemode"],
  "maxTurns": 10,
  "maxToolCalls": 6,
  "maxDurationMs": 300000,
  "coordinator": {
    "saveDir": "/absolute/reports/review-01",
    "forkFrom": "settled-facts-session",
    "tasks": [
      { "label": "recovery", "prompt": "Check recovery for concrete races. Return file:line, trigger and evidence; preserve uncertainty." },
      { "label": "handoff", "prompt": "Check handoff code against its documentation. Return specific discrepancies and evidence." }
    ]
  },
  "prompt": "Dispatch the approved reviewers with codemode, retain full reports, then give at most five short findings with reviewer/session references, disagreements and failed coverage; keep explanations in original reports. Agreement is not proof. Ask the caller if children need answers."
}
```

Omit `forkFrom` without a settled fact session. It can also be specified per child.
Branches reuse that history, with fresh budgets; independent reviews may instead start
without a shared opinionated transcript. Choose actual model IDs with `models`; each
child can set `model`, `thinking`, `tools` and its own budgets.

## Three tools inside codemode

- `delegate_start_batch({taskIndexes?})`: zero-based indexes into the caller's plan;
  omission starts all remaining tasks. Each successfully started index is dispatched once; concurrent duplicate
  attempts are refused. Validation/capacity failure before launch permits a later retry.
  Partial startup failures include their original `taskIndex` and error and can be
  retried by index without rerunning siblings. A returned session that later errors
  remains dispatched; inspect its result rather than starting duplicate work.
- `delegate_wait({sessionIds?, timeoutMs?})`: all-settled wait, maximum 55 seconds;
  omission selects all launched children. Returns compact state, questions, errors,
  termination and save diagnostics; it does not repeat report bodies.
- `delegate_get({sessionId})`: full report and result metadata for a child launched
  by this coordinator, including text omitted from normal saved-result responses.

For example, execute [coordinator.js](../examples/coordinator.js) through codemode.
It stores full reports and prints only a receipt; a subsequent script can use
`load("team.reports")` to synthesize without fetching reports again. Scripts are examples,
not mandatory strategies. Stronger models can choose their own sequencing and analysis.

## Boundaries

- First version: **memory-only, one level, built-in read-only child tools**
  (`read`, `grep`, `find`, `ls`, or `[]`). Child extensions/native MCP/coordinator are
  off. Web research remains available through [native MCP](../research.md) separately.
  `durable: true` with `coordinator` is rejected: dispatch membership is not persisted,
  so this does not promise restartable group execution.
- Child defaults: 10 turns, 12 own tool calls, 240 seconds, bounded by the server's
  turn/time ceilings. Explicit child budgets are checked against the same ceilings.
- The coordinator occupies a concurrency slot. With the default limit of four, it
  can start at most three children at once when no other work is running. Larger
  plans can launch subsets in successive batches; there is no new admission queue.
- Cancelling a wait **or the coordinator** leaves children running within their own
  budgets. Their IDs appear in ordinary `sessions`/`status`/`wait`; the main agent
  can `answer` questions or `abort` them. `delegate_wait` surfaces pending questions;
  answer them before waiting again.
- Saved originals and in-memory reports follow existing retention. `store/load` has
  the installed SDK's size limits and commits only after successful scripts; keep
  file references for oversized reports. A failed script must not be assumed to
  have committed its store writes. Errors/aborts may have no saved report.
- `maxToolCalls` counts the coordinator's own calls, not each nested child-tool call.
  The fixed caller plan bounds dispatches; child budgets and registry admission still
  apply. Tool access is not an OS sandbox. Report saving is an authorized host write.
