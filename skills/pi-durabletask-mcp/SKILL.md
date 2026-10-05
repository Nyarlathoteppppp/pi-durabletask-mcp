---
name: pi-durabletask-mcp
description: Use an already-connected Pi MCP server to delegate investigations, reviews, or explicitly authorized implementation.
---

# Pi delegation

Use the connected server's tools; names below omit client-specific prefixes.

## Delegate and collect

- Call `spawn` with an absolute project `cwd`; put the goal, context, constraints, allowed scope, and required evidence in `prompt`.
- Omit `model` and `tools` for the configured model and read-only defaults; `init` is optional diagnostics.
- To review a diff or share long notes, write them to a file and pass its absolute path in `attachments` rather than pasting them into `prompt`.
- Match the prompt to the model: give fast, small models a bounded checklist (what to grep, what to compare, a tool-call cap); give open-ended bug hunts to stronger reasoning models. `models` lists each model's accepted `thinking` levels.
- Budget turns with headroom. The last turn has no tools and asks for a conclusion from available evidence; timeouts, provider/auth errors or cancellation can still interrupt it. `usage` in the result shows tokens and cost.
- While running, `idleMs` is the time since the delegate's last event and `phase` is `model`, `tool` or `agent`. A long `idleMs` in phase `model` is slow reasoning or a hung request; `steer` lands only after the current turn, so decide whether to wait or `abort`.
- For authorized implementation, select the needed server-permitted write tools and keep work within the user's scope.
- Keep the returned `sessionId`; loop `wait` with `until: "settled"` until finished. Answer pending questions using `questions[].id` as `answer.requestId`, then wait again.
- For independent tasks, use `spawn_batch`; wait with `sessionIds`, answer questions, then pass returned `continueIds` as the next wait's `sessionIds` until none remain.
- Follow `nextAction`: `wait` to keep collecting, `answer` to resolve pending questions, `finish` when this run ends—not necessarily successfully; check `state`, `error`, `termination` and the result.
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
