# Changelog

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
