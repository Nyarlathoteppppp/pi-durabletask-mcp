# Changelog

## 0.7.8 (2026-10-07)

- `status`, `run` and single/batch `wait` include `touchedFiles` and `editWriteCount` for successful edit/write calls in the current run, including nested calls. This is an operation receipt, not a Git diff or test verification; read-only runs omit it.
- Receipts reset on accepted follow-ups, survive durable recovery and stay out of forked sessions. A follow-up refused during authentication preserves the previous receipt; legacy checkpoints do not infer it from cumulative history.

## 0.7.7 (2026-10-06)

- Wrap-up prompts respect the requested answer format and length, preserving concrete findings and important limitations without requiring extra sections.
- Batch `wait` summaries include `forkedFrom` for forked sessions; ordinary sessions omit it.
- The bundled skill explains when to fork a shared facts session for parallel questions and when to continue with `follow_up`.

## 0.7.6 (2026-10-06)

- `forkFrom` on `spawn`, `run` and `spawn_batch`: start independent tasks from a settled session's history, with fresh budgets and child-only usage. Omitted execution settings inherit from the parent and are revalidated. `forkedFrom` reports the source in results and session lists.
- Durable forks save their initial transcript before catalog publication and consume it atomically when creating the first task, so recovery also works before the first prompt. Existing recovery and ownership remain unchanged.
- Tested cross-model forks with Codex → DeepSeek and Gemini → Codex. Inherited history is still sent to the provider; cache savings depend on the provider.

## 0.7.5 (2026-10-06)

- Preserve exact MCP tool grants with Pi 1.0.4: codemode and tool search cannot inherit unnamed server or resource tools. Explicitly granted resource tools remain available.
- Support Pi 1.0.1 project MCP overrides for `enabled`, `exposure` and `toolExposure`, retaining the global transport and credential origin.
- A recovered assistant response cut off by the output limit is kept as a partial answer instead of being aborted or unnecessarily rerun. Newly accepted steering still takes precedence.
- A cancelled follow-up clears the previous run's completion metadata and cannot report a negative elapsed time. Failed recovery cleanup keeps ownership until storage has actually closed.
- `saveTo`/`saveDir` write to a temporary file beside the target and rename it into place, so a crash during the write never leaves a partial file.
- The READMEs state that only macOS and Linux are supported (session ids may contain `:`, the status line uses `ps`, and the SDK link uses a directory symlink).
- A background recovery that failed for a passing reason (an auth refresh, the runtime starting) kept the job's lock and a dead `error` worker in its process, so neither it nor another process retried the job until a restart. It now hands the job back with the attempt counted, and a later recovery tick retries it; only a job past `PI_DELEGATE_MAX_RECOVERY_ATTEMPTS` is kept and reported, as before. A job that failed is not reclaimed within the same recovery pass, so a passing failure cannot spend every attempt at once.

## 0.7.4 (2026-10-06)

- codemode without native MCP: naming `codemode` in `tools` (after authorizing it with `PI_DELEGATE_ALLOW_TOOLS`) lets the delegate write a script that calls its other tools, for example several reads at once, with only the script's output returned to the model. Nested calls are traced under the script and pass the same secret-path guard; Pi's model API stays off inside scripts.
- `PI_DELEGATE_DEFAULT_TOOLS` (comma list) sets the tools of a call that names none, for example `read,grep,find,ls,codemode`; each must be permitted.
- CI covers Pi 1.0.0 and 1.0.4.
- `maxToolCalls` on `spawn`, `run` and `spawn_batch` (batch default, per-task override): a cap on the delegate's own tool calls for the whole session. Models do not track their own calls, so at 75% of the cap the wrap-up reminder tells them the exact count, and at the cap the next turn has no tools and must answer. Calls inside a codemode script or MCP tool do not count; one turn's parallel calls can overshoot the cap. Reported in `limits.maxToolCalls`.
- A result saved with `saveTo`/`saveDir` that is 1500 characters or shorter is also returned inline: reading the file back would cost more than it saves.
- `answerState` is reported only for `done` runs; an aborted or failed run already says why it has no conclusion.

## 0.7.3 (2026-10-06)

- `saveTo` on `spawn`, `run` and `follow_up`, and `saveDir` on `spawn_batch`: when the run finishes as done, its final text is written to that file before the run is reported finished, and results show `savedTo`/`savedChars` instead of the text. Bad or secret paths are refused up front; a failed write keeps the text and adds `saveError`. `wait` and `status` stay read-only.
- A dangling symlink to a secret name (for example `result.md` -> a missing `.env`) passed the secret-path check, since only existing paths were resolved; writing through it created the secret file. Dangling links are now followed. This also covers the delegate's own file tools.
- A `follow_up` cancelled before it reached Pi still reported the previous run's text (and, with this release, its saved file and answer flag) as its own; they are cleared as soon as it is cancelled. A `follow_up` refused at authentication leaves the previous result as it was.
- `answerState` on finished results whose text is not a usable conclusion: `missing` (no text) and `partial` (cut off by the output limit) by rule; `narration` from the optional Jev judge (`PI_DELEGATE_JUDGE=jev`), reported only at probability 0.95 or more. See `bench/answer-state/README.md` for how far that is reliable.

## 0.7.2 (2026-10-06)

No change to the server's behaviour.

- Every test that runs the registry in-process retries its temporary-directory cleanup, since queued registry writes can land during it (seen once in CI as `ENOTEMPTY`).
- `bench/answer-state/`: an evaluation of Jev, a fast classification model, for telling a delegate's real conclusion from narration such as "Let me look at…". Ground truth was frozen before any Jev call; on a held-out set the frozen policy reported narration twice with one false alarm, so the feature is not shipped. Only aggregates are published; the texts stay private.

## 0.7.0 (2026-10-06)

- While a delegate runs, `status`, `wait` and batch summaries report `idleMs` (time since its last event; stream deltas, including reasoning, count) and `phase` (`model` while a model request is outstanding, `tool` while a tool runs, `agent` in between; neither while a question waits for an answer). Before, a delegate silent for minutes in one model turn looked the same as one making progress.
- `PI_DELEGATE_STALL_MS`, off by default: a run that produces no event for that long while waiting on the model ends as `termination.reason: "stalled"` and can be continued with `follow_up`. Pi never times out a silent request itself.
- `handoff read` no longer puts a resume hint such as `session_missing` into `followUpBlockedReason`, which takes only its documented values.

## 0.6.0 (2026-10-05)

- `run` returns the same compact result as `wait` by default: answer, state, errors, usage and continuation. Pass `verbose: true` for the full snapshot with configuration and the whole tool trace.
- `status`, `wait`, `sessions` and `run` report `remainingTurns`, `canFollowUp` and, when it cannot, `followUpBlockedReason` (`running`, `finalizing`, `turn_budget_exhausted`, `not_started`, `status_required`). `sessions` takes `cwd` to list one project's loaded and stored sessions. A handoff whose session has used all its turns says `status_then_spawn`.
- A symlink named like a secret (`.env`, `.ssh`, ...) pointing to an ordinary filename was not refused; both the path as given and its target are now checked.
- Native MCP tools that registered after the tools were removed for the last turn reappeared on that turn; they stay removed.
- `PiWorker` keeps each run's timers, wrap-up flags, provider error, cancellation and completion in its own `WorkerRun`, so callbacks of an earlier run cannot change a later one. This also fixes three failures: a failed task creation left the worker counting as active; a failed checkpoint save during cancellation left the SDK running; a failed final catalog write made the completion promise reject (the answer is now kept and the error shown).
- READMEs and the skill no longer promise that a delegate always answers: the last turn has no tools, but a provider error or a crash can still end a run without one.

## 0.5.0 (2026-10-05)

From real use as a code reviewer. A gpt-6-astra design review and a gpt-6.1-sol code review shaped it.

- The session's last turn has no tools. At the end of the turn before it, the tools are removed and the delegate is told to answer, so a model that ignores the wrap-up reminders still ends with an answer instead of being aborted at the turn limit with nothing to show. A run that starts with one turn left starts without tools.
- `attachments` on `spawn`, `run`, `follow_up` and `spawn_batch` (batch-wide or per task, `[]` for none) takes absolute paths of text files. The server appends them to the prompt, so a caller can pass a diff from its scratchpad without copying it into its own output. At most 20 files, 256 KiB each, 1 MiB in total; UTF-8 text only. Secret paths are refused, also through symlinks. Durable sessions store the expanded prompt, so recovery never reads the files again.
- `models` returns `thinkingLevels`, the levels each listed reasoning model accepts, and a refused `thinking` level now says which levels the model supports. Validation follows Pi's own rules: an unmapped level up to `high` was wrongly refused, and `xhigh`/`max` were wrongly accepted for models without a level map.
- Finished results (`status`, `wait`, batch summaries) carry `usage`: input, output and cache tokens and the cost by Pi's model prices, for the whole session including follow-ups.
- Pi's `auth.json` in a custom `PI_CODING_AGENT_DIR` is treated as a secret path, both for attachments and for the delegate's own file tools. Before, only `~/.pi/agent/auth.json` was.

## 0.4.4 (2026-10-04)

- Add `nextAction` (`wait`, `answer`, `finish`) to spawn, follow-up, status and wait responses, including per-session and top-level batch spawn/wait guidance. Keep existing `next`; `finish` means the run ended, not that it succeeded.
- Single-session `wait` omits traces and diagnostic metadata by default, retaining results, questions, notices, errors, termination and progress counts. `verbose: true` still returns the full snapshot; `status` remains diagnostic and batch waits remain summaries.
- Spawn, status and follow-up now use wait's state rule: a terminal worker still submitting its final result or cleaning up cancellation remains `running` to callers until that work ends.

## 0.4.3 (2026-10-04)

- Add official MCP Registry metadata (`mcpName` and packaged `server.json`). No runtime logic changes.

## 0.4.2 (2026-10-04)

- Publish the portable Agent Skill in the npm package to guide use of an already-connected MCP server.
- Simplify the English and Chinese READMEs and add optional skill installation instructions. No runtime logic changes.

## 0.4.1 (2026-10-04)

From a gpt-6.1-sol review of 0.4.0.

- The time-budget wrap-up steer could land while the delegate was writing its final answer, which made Pi take one more turn after it; that turn could replace the answer or run into the deadline. Now 2/3 of the time budget only marks the run, and the steer is sent at the end of the next turn that called tools.
- An `abort` during a `follow_up`'s provider authentication, followed at once by another `follow_up`, let both reach Pi: the first saw the second's `starting` state and did not know it had been cancelled. A superseded start now stops after authentication.

## 0.4.0 (2026-10-04)

First version meant for everyday use. 0.3.9 was never tagged; its changes are listed here.

- The wrap-up steer is also sent at 75% of the time budget when that comes before 75% of the turns, and only while the delegate is still calling tools. Before, a slow model (large context, high thinking) could hit the deadline with no answer at all, because it never reached the turn reminder. At most one wrap-up steer is sent per run.

- Cancelling a delegate during OAuth refresh or task creation no longer starts a model request afterward. Durable cancellation is committed as the final result.
- `wait` reports completion after the worker finishes committing its result. A timeout during finalization stays `running`, including batch `pending`/`continueIds`, so immediate `follow_up` works after a settled result.
- `forget` checks and disposes the worker obtained after a pending lazy load, awaits native MCP shutdown before deletion, and refuses active work. A concurrent `follow_up` cannot execute on a worker already forgotten or unloaded.
- The 75% turn-budget reminder permits essential verification and reserves a final-answer turn, instead of forbidding all further tools. The hard turn limit is unchanged.

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
