# Caller-planned codemode coordination

A main agent supplies a plan; one Pi coordinator dispatches, waits and synthesizes
using JavaScript loops/conditions. It shares the existing execution core with ordinary
MCP tools. Original child reports remain available by session ID and saved file.

Enable `codemode` in `PI_DELEGATE_ALLOW_TOOLS`. Start the coordinator with `spawn`
(or `run`; batch tasks can also carry `coordinator`):

```json
{
  "cwd": "/absolute/repo",
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
  }
}
```

With `coordinator`, omit `prompt` for dispatch, wait, report collection and a concise
synthesis of findings, disagreements and incomplete coverage, citing original reports.
Omit `tools` for `["codemode"]`; the server must still permit it. These team defaults
apply before fork inheritance. Explicit `prompt` replaces the default strategy, while
explicit tools (including batch defaults) are preserved and must contain `codemode`.
Ordinary delegates still require `prompt`. For parallel reports without a synthesis,
use `spawn_batch` and `wait` directly; no coordinator is needed.

Omit `forkFrom` without a settled fact session. It can also be specified per child.
Branches reuse that history, with fresh budgets; independent reviews may instead start
without a shared opinionated transcript. Choose actual model IDs with `models`; each
child can set `model`, `thinking`, `tools` and its own budgets. `research: true`
adds the configured Exa search/fetch pair; `research: false` per task overrides the
plan. Configure [Exa](../research.md) and grant both exact names in the server allowlist.
It is off when omitted. `tools: []` with research enabled means Exa-only,
not no tools. Models choose when to browse; ask for source verification when needed.

## Member MCP tools

Each member can select configured `github`, `serena`, `browser` or `exa` servers and
their reviewed operations. Grant the exact tool names in the host's
`PI_DELEGATE_ALLOW_TOOLS`, using the [optional setup](../optional-tools.md). For example,
add these members to `coordinator.tasks`:

```json
[
  {
    "label": "ci",
    "prompt": "Check OWNER/REPO's CI failures and cite the relevant logs.",
    "mcpServers": ["github"],
    "tools": ["mcp__github__actions_list", "mcp__github__get_job_logs"]
  },
  {
    "label": "symbols",
    "prompt": "Find recovery callers in this project with Serena.",
    "mcpServers": ["serena"],
    "tools": ["mcp__serena__initial_instructions", "mcp__serena__find_symbol", "mcp__serena__find_referencing_symbols"]
  }
]
```

`mcpServers` selects connections, never all tools on a server. Omitted `tools` still
means `read/grep/find/ls`; explicit lists replace those defaults. Each MCP tool must
have its server selected. Set `exposure: "direct"` on these servers in Pi's `mcp.json`
(or a direct per-tool override): children do not receive `codemode`/`tool_search`
to discover deferred tools. `research: true` unions in Exa's server and exact search/fetch
pair without duplicates; a member can use `research: false` to disable that shorthand.
Parent/fact-session server selections are not inherited, and follow-ups retain the
member's exact grants.

Allowed operations match the GitHub/Serena lists in the optional setup. Browser
members can use `agent_browser_open`, `agent_browser_snapshot`, `agent_browser_scroll`,
`agent_browser_get_text`, `agent_browser_get_url` and `agent_browser_close` under
`mcp__browser__`; form entry, clicks and JavaScript execution are excluded. Browser
navigation and Serena project activation can change session state or create caches;
this is a read-only task workflow, not an OS sandbox. Use configured servers you trust;
external MCP tools are not wrapped by Pi's built-in secret-file guard.

## Four tools inside codemode

- `delegate_start_batch({taskIndexes?})`: zero-based indexes into the caller's plan;
  omission starts all remaining tasks. Each successfully started index is dispatched once; concurrent duplicate
  attempts are refused. Validation/capacity failure before launch permits a later retry.
  Partial startup failures include their original `taskIndex` and error and can be
  retried by index without rerunning siblings. A returned session that later errors
  remains dispatched; inspect its result rather than starting duplicate work.
- `delegate_wait({sessionIds?, timeoutMs?})`: all-settled wait, maximum 55 seconds;
  omission selects all launched children. Returns compact state, questions, errors,
  termination, save diagnostics and `nextAction`; it does not repeat report bodies.
- `delegate_get({sessionId})`: full report and result metadata for a child launched
  by this coordinator, including text omitted from normal saved-result responses,
  `nextAction`, remaining turns and follow-up readiness.
- `delegate_follow_up({sessionId, prompt, maxTurns?, maxToolCalls?})`: ask a finished
  child for a missing conclusion or verify a specific claim. Same history, model and
  tool grants; omitted budgets keep remaining quotas, explicit fields renew only
  those quotas. Wait again, then refresh the report with `delegate_get`. When the
  plan has `saveDir`, each follow-up saves a separate report there, preserving the
  first report. There is no automatic follow-up or required debate round.

For example, execute [coordinator.js](../examples/coordinator.js) through codemode.
It stores full reports and prints only a receipt; a subsequent script can use
`load("team.reports")` to synthesize without fetching reports again. Stored data is visible to the
model only after a script emits the relevant evidence through `text()` or `return`. Scripts are examples,
not mandatory strategies. Stronger models can choose their own sequencing and analysis.
For a specific unresolved claim, [coordinator-follow-up.js](../examples/coordinator-follow-up.js)
shows a bounded follow-up that keeps both reports; run it in the same coordinator
session and replace its placeholder with the claim. A new coordinator does not inherit
the first one's dispatch membership or codemode storage.

The four tools declare their actual result fields for Codemode's TypeScript signatures. Optional
recipes: [filter report excerpts](../examples/coordinator-evidence.js),
[revisit stored evidence](../examples/evidence-revisit.js), and
[discover authorized tools](../examples/discover-tools.js). Text matching is a mechanical filter,
not a correctness judgement: keep errors, incomplete coverage and original report references.
Use `store` for small IDs/cursors/excerpts; inspect originals whenever the excerpts lack context.

Members can select `resources.contextFiles` and `resources.skills` using absolute file paths.
They do not inherit the coordinator's selection; [resource semantics](../reference.md#explicit-instructions-and-skills)
also apply to member forks and follow-ups.

## Saved team index

With `coordinator.saveDir`, the four tools also return `reportIndex`: a unique
`team-<UUID>.json` in that directory. It records task labels/indexes, actual models,
session IDs, observed state/errors and successfully saved original/follow-up report
references. Original report bodies remain in their own files; prompts and report
bodies are not copied into the index. Index IO failure returns `reportIndexError`
without undoing a successful dispatch or follow-up.

Outer `status`, `run` and single/batch `wait` also carry `reportIndex` after a successful
publication, including across coordinator follow-ups. A later failure keeps that last
successful path and adds `reportIndexError`; the old snapshot may be stale or absent.
The next successful publication clears the error. These fields require no model-written
reference or additional filesystem read.

The index updates only when the coordinator starts, waits, reads or follows up;
check `updatedAt`/task `observedAt`. It can be stale if the coordinator ends without
collecting its children. A new window can read the files, but the index does not
restore a team, transfer ownership or resume memory-only sessions. Omit `saveDir`
for no index IO. This is a report snapshot, not a runtime checkpoint.

## Boundaries

- **Memory-only, one level, read-only child tools**: built-ins (`read`, `grep`,
  `find`, `ls`, or `[]`) plus explicitly selected, reviewed GitHub/Serena/browser/Exa
  tools. Research selects `exa` and its exact authorized pair; servers/tools are not inherited. Child
  third-party extensions/coordinator are off; codemode is not implicitly granted.
  `durable: true` with `coordinator` is rejected: dispatch membership is not persisted,
  so this does not promise restartable group execution.
- Child defaults: 10 turns, 12 own tool calls, 240 seconds, bounded by the server's
  turn/time ceilings. Explicit child budgets are checked against the same ceilings.
- The coordinator occupies a concurrency slot. With the default limit of four, it
  can start at most three children at once when no other work is running. Larger
  plans can launch subsets in successive batches; there is no new admission queue.
- Cancelling a wait **or the coordinator**, or the coordinator finishing without waiting
  for them, leaves children running within their own budgets. Their IDs appear in ordinary `sessions`/`status`/`wait`; the main agent
  can `answer` questions or `abort` them. `delegate_wait` surfaces pending questions;
  answer them before waiting again.
- Saved originals and in-memory reports follow existing retention. The current Pi
  SDK limits `store/load` to 262144 JSON characters per value and 1048576 in total,
  with writes kept only after successful scripts; keep file references for oversized
  reports. A failed script must not be assumed to have committed its store writes.
  Errors/aborts may have no saved report.
- `maxToolCalls` counts the coordinator's own calls, not each nested child-tool call.
  Allow headroom in turns/calls for repeated waits; set slower members' `maxDurationMs`
  explicitly when the default four minutes is insufficient. Follow-ups retain that time limit.
  The fixed caller plan bounds dispatches; child budgets and registry admission still
  apply. Tool access is not an OS sandbox. Report saving is an authorized host write.

See [three live review trials](coordinator-trials.md) for measured wait/output behavior
and review limitations; these are usage observations, not an accuracy benchmark.
