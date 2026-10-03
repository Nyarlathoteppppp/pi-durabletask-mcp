# Changelog

## Unreleased

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
