# Changelog

## 0.3.8 (2026-10-04)

- `resolve` and `forget` yielded once before looking up a session even when nothing was unloading. History eviction running in that gap left this process holding the session's lock with no worker, so the call reported `Unknown sessionId`. `forget` during a load in this process failed the same way; it now waits for the load.
- `spawn_batch` with `durable: true` and `retentionDays` rejected the whole batch when a task set `durable: false`, because that task still inherited `retentionDays`. The batch's `retentionDays` now goes only to its durable tasks, and setting it on a batch with no durable task is still refused.
- `Unknown sessionId` also names the other way a memory session disappears: once finished, it is dropped after `PI_DELEGATE_HISTORY` (default 50) newer sessions.
- The concurrent `follow_up` test asserts that exactly one starts, the other is refused as running, and only one turn is added.

## 0.3.7 (2026-10-04)

- Recovery could claim a durable job that its owner finished and released between recovery's scan and its lock, holding a finished session and counting an attempt. It now re-checks `finished_at` after locking.
- Two calls that loaded the same stored session at once (for example two `follow_up`s) could fail the second with `Unknown sessionId`.
- The `handoff.sqlite` migration runs in one write transaction, so two MCP processes opening an old file together no longer fail with `duplicate column name: seq`. Old notes saved in the same millisecond are ordered deterministically, by `saved_at` and then by row order; the true order among them cannot be recovered.
- `handoff`'s `cwd` description says that `save` needs the session's own cwd.

## 0.3.6 (2026-10-04)

- `handoff save` refuses a session whose working directory is not the note's `cwd`, so a note for one repository cannot point a new window at another repository's session.
- `handoff.sqlite` created by the first handoff commit, without the `seq` column, is migrated when opened.
- `handoff` no longer promises that the reading window itself resumes a released session: any running MCP process may claim it first.

## 0.3.5 (2026-10-04)

- `handoff` tool: `save` records which Pi session a repository's work is in, with the calling agent's goal, completed and next; `read` returns the newest note (or a named one) for a new Claude/Codex window, with a `resumeHint` computed from the session's live state. Notes live in a separate `handoff.sqlite`; reading never claims, loads, locks or recovers a session, and a note's recorded start time keeps a reused session id from being mistaken for the original.
- Servers look for abandoned durable delegates every 30 seconds (`PI_DELEGATE_RECOVERY_INTERVAL_MS`), and when a caller asks for one waiting for recovery. Before, a delegate whose owner exited while this server was idle waited for the next restart.
- A recovery claim that succeeded just as shutdown began registered its worker anyway; it is now handed back (lock released, attempt not counted).
- A `run` whose caller had already cancelled, or cancelled during start, still prompted Pi before being aborted. Cancellation is now bound as soon as the worker exists, so such a run never starts.
- `init` fails with the per-provider reasons when every provider in scope has failing credentials, instead of reporting ok with no usable model.
- CI runs on Pi 1.0.0 and 1.0.2, each on Node 22 and 24.

## 0.3.4 (2026-10-04)

- `spawn_batch` checks every task before starting any: the model it will really use, including Pi's own default, thinking support and provider credentials. A bad task no longer leaves its siblings running.
- `models` leaves out providers whose credentials fail, like `init` and `spawn`, reports them under `failingProviders`, and `defaultUsable` accounts for them.
- Batch `wait` returns `continueIds`: every session not finished, including those waiting for an answer. Waiting again on `pending` alone dropped a session once its question was answered.
- Recovery that retried after a busy lock reused the capacity and shutdown state from before its wait, so new work started meanwhile could push it past `PI_DELEGATE_MAX_CONCURRENT`, and it could still register work after shutdown began. Each claim attempt now reads both afresh.
- `models` resolves the default the way `spawn` does, so a short id such as `grok-4.7` is no longer reported as unusable.
- The claim-race test's claimer processes no longer fall through into the parent flow.
- `spawn_batch` refuses a task when no model is named anywhere (no `model`, no `PI_DELEGATE_MODEL`, no Pi default), since Pi would only choose one after the siblings started.
- A provider named like an `Object.prototype` member is no longer treated as failing.
- Builds against Pi 1.0.2, whose pi-ai types differ from the pi-ai Pi Durable pins; the SDK runtime is passed to Pi Durable through an explicit cast at that boundary.

## 0.3.3 (2026-10-04)

- `wait` takes `until: "settled"` to return only when a delegate finishes or asks a question, so one loop gets the result without waking on every tool call.
- `wait` takes `sessionIds` to wait on several delegates, such as a `spawn_batch`: it returns when any settles (`settled`) or all do (`all_settled`), with settled and pending ids and a short summary per session that includes the final text of finished ones.
- `spawn_batch` returns `sessionIds` and points to `wait` instead of polling `sessions`; batch `wait` summaries include pending questions, so `answer` needs no extra `status`.
- Errors say why a session is unavailable: unknown (memory-only sessions end with their process), running or loaded in another process, or waiting for recovery. `steer` on a finished session points to `follow_up`.
- `models` reports `defaultModel`, the model a spawn without `model` gets, and whether it is usable.
- `spawn` and `follow_up` results say how to collect the answer (`next`: wait with `until: "settled"`).
- `models` returns `LIST_CAP` (60) models per page by default instead of 200, with a note when more match.
- Two processes claiming the same abandoned job at the same instant could both back off and leave it unclaimed until something else triggered recovery: each held a shared lock while the other tried to upgrade. A claim that finds a busy lock and claims nothing now takes one jittered second look; lazy loading does the same. Measured: simultaneous claims left the job unclaimed in 54 of 60 rounds before, 0 of 60 after.

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
