---
name: pi-durabletask-mcp
description: Use an already-connected Pi MCP server to delegate investigations, reviews, or explicitly authorized implementation.
---

# Pi delegation

Use the connected server's tools; names below omit client-specific prefixes.

## Delegate and collect

- Call `spawn` with an absolute project `cwd`; put the goal, context, constraints, allowed scope, and required evidence in `prompt`.
- Omit `model` and `tools` for the configured model and read-only defaults; `init` is optional diagnostics.
- For authorized implementation, select the needed server-permitted write tools and keep work within the user's scope.
- Keep the returned `sessionId`; loop `wait` with `until: "settled"` until finished. Answer pending questions using `questions[].id` as `answer.requestId`, then wait again.
- For independent tasks, use `spawn_batch`; wait with `sessionIds`, answer questions, then pass returned `continueIds` as the next wait's `sessionIds` until none remain.
- Use `steer` while running; use `follow_up` when finished to preserve context. Turns accumulate across follow-ups.
- Cancelling `wait` only stops waiting; use `abort` to stop the delegate.

## Recovery and handoff

- Sessions are in memory by default. Set `durable: true` at creation for restart recovery or cross-window continuation; retained history is required.
- Recovery still obeys run limits, including downtime; persistence does not mean execution continues without a running bridge.
- When asked to hand over, call `handoff` with `action: "save"`, the original `cwd`, `sessionId`, and your own `goal`, `completed`, and `next` notes.
- When asked to resume, call `handoff` with `action: "read"` and the project `cwd`; follow `resumeHint` and `howToResume`, without spawning duplicate work.
- Reading a note does not take ownership. Cross-window continuation needs the same local state and retained task and note; a live owner must release the task first.

- For interrupted tools with unknown side effects, inspect external state before retrying; never blindly replay them.
- Verify the delegate's findings, cited files, changes, and test evidence before reporting completion; distinguish confirmed results from unresolved claims.
