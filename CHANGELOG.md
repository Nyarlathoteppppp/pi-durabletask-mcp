# Changelog

## Unreleased

- Match staged nested results by parent relationships, including deeper nesting, without relying on tool-call ID prefixes.
- Add an isolated checkpoint benchmark using the real DurableJob and SQLite commit path.

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
