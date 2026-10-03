# Changelog

## Unreleased

- `wait` takes `until: "settled"` to return only when a delegate finishes or asks a question, so one loop gets the result without waking on every tool call.
- `wait` takes `sessionIds` to wait on several delegates, such as a `spawn_batch`: it returns when any settles (`settled`) or all do (`all_settled`), with settled and pending ids and a short summary per session that includes the final text of finished ones.

## 0.3.2 (2026-10-04)

- Make `init` optional setup/auth diagnostics; tools work directly after connection, with short server and agent instructions.
- Validate Pi's configured default model against the same delegate allowlist, denylist and project scope as an explicit model, before a model request.
- Return pending questions promptly from `wait`, preserving background execution and cancellation behavior.
- Advertise tool read/mutation annotations without changing client approval policy.
- Extract a protocol-independent execution core; existing MCP tools preserve their schemas and behavior, with shared-state and cancellation/progress regressions.
- Persist the model actually selected by Pi when a caller uses its configured default, so unfinished tasks recover with a resolvable model ID.
- Recover exhausted deadlines and turn budgets without provider authentication; a saved final answer still takes precedence.
- Reclaim orphan job directories left by interrupted deletion before applying storage pressure, protecting active owners and otherwise retainable history.
- Reject an existing metadata table with a missing ownership protocol; initialize new metadata and its protocol in one transaction.
- Delegates are in memory only by default; pass `durable: true` to save, recover and keep one.
- `retentionDays` (1-365) on `spawn`, `run` and `spawn_batch` sets how long a durable delegate is kept; `PI_DELEGATE_RETENTION_DAYS` remains the default.
- The final state of a finished durable delegate is recorded in the catalog, so any process can read it with `status` or `wait` without loading it, even while another process has it loaded. Only `follow_up` takes ownership.
- Session ids of durable delegates are unique in the catalog, so two processes spawning the same id at once cannot both succeed.
- A finished delegate's completion and final state are recorded in one statement; a crash in between leaves it unfinished for recovery instead of showing a previous run's state.
- The wall-clock limit applies to each run (spawn or follow_up); turns stay cumulative. Durable sessions kept for days can be followed up.
- Default retention is fixed when a durable delegate is created, so processes with different defaults agree.
- Over the storage limit, finished delegates loaded in this process are unloaded so they can be deleted. The limit covers job stores, not the catalog.
- The secret path guard resolves symlinks in the nearest existing parent, so a new file under a symlink to a secret directory is blocked.
- An existing catalog's ownership protocol is checked before its schema is migrated.
- `PiWorker` defaults to non-durable, matching MCP callers; workers loaded from the catalog are always durable.
- A delegate aborted outside a run (a recovered task already past its budget) records when it finished.
- A catalog that already holds duplicate session ids still starts, with a warning, and stays readable, but refuses new durable delegates until the duplicates are forgotten, so the race cannot recur.
- Provider credentials are checked when a run is about to call the model (spawn, follow_up, recovery with work left), not when a recovery only records an answer already given. A refused follow_up leaves the session unchanged.
- abort is refused for a finished session instead of changing its state in memory only.
- elapsedMs stops at the finish of a run.

## 0.3.0

- Initialize Pi HTTP networking in SDK hosts and test compressed TLS responses.
- Cover retention timestamp changes between scanning and acquiring ownership.

- Match staged nested results by parent relationships, including deeper nesting, without relying on tool-call ID prefixes.
- Add an isolated checkpoint benchmark using the real DurableJob and SQLite commit path.
- Own durable stores with kernel-released SQLite locks instead of PIDs: reused PIDs no longer block recovery, and stopped or hung owners are never taken over.
- Move durable state to ownership protocol 2 under `durable/v2/`, isolated from older builds that may still be running; the catalog records and checks its protocol.
- Stop resuming a task after `PI_DELEGATE_MAX_RECOVERY_ATTEMPTS` claims without progress (default 3), so a task that crashes its host cannot crash every host.
- Keep lock files as tombstones after `forget`, so no open lock file is ever deleted.
- Add `durable: false` to `spawn`, `run` and `spawn_batch`: memory-only delegates that write nothing and end with the process.
- Retain finished durable delegates for `PI_DELEGATE_RETENTION_DAYS` (default 7) under a `PI_DELEGATE_STORAGE_LIMIT_MB` cap (default 1024); unfinished delegates are never deleted.
- History eviction now only unloads from memory; finished delegates stay on disk, are listed under `stored`, and load on first use by id.
- Startup recovery resumes only unfinished delegates instead of loading every finished one.
- `status` and `wait` are compact by default: the last 5 tool calls with shortened arguments, `toolCallCount`, and the newest notices. `verbose: true` returns everything.
- Record Pi's automatic provider retries as notices, and say in `error` when a run failed after them.
- `init` resolves each provider's credentials, refreshing OAuth tokens that would expire mid-run, reports failures under `failingProviders`, and stops offering their models; spawning one fails before anything starts.
- `grep` finds ripgrep in Pi's tool directory before PATH, and reports a missing one clearly in `init` and in the tool result.

## 0.2.0

- Add independent `nativeMcp` and explicit `mcpServers` selection to single and batch tasks.
- Reuse the server tool allowlist and Pi SDK restrictions for direct and nested MCP tools.
- Persist nested call intent and results; preserve completed child results after script interruption.
- Close native MCP transports on forget and shutdown; reconnect on recovery.
- Add native direct, codemode, deferred, batch, permission, and crash integration tests.

## 0.1.0

Initial durable task edition, based on pi-delegate-mcp.

- Persist SDK conversations, worker state, results, and pending steering with Pi Durable 1.0.
- Recover abandoned tasks using SQLite ownership claims across MCP processes.
- Commit the current task pointer atomically with task creation, including follow-ups.
- Retain recovery steering until its user message is committed with the updated queue.
- Stop SDK execution on suspension while recording tools until idle, then save and close.
- Remove temporary tool result copies once their transcript messages are committed.
- Link to the global Pi SDK and report the loaded SDK version and path through init.
- Add offline crash, recovery, suspension, follow-up, and awaited tool barrier tests.
