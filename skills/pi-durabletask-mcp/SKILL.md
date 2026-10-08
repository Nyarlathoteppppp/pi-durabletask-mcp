---
name: pi-durabletask-mcp
description: Use an already-connected Pi MCP server to delegate investigations, reviews, or explicitly authorized implementation.
---

# Pi delegation

Use the connected server's tools; names below omit client-specific prefixes.

## Delegate and collect

- Call `spawn` with an absolute project `cwd`; put the goal, context, constraints, allowed scope, and required evidence in `prompt`.
- Omit `model` and `tools` for the configured model and read-only defaults; `init` is optional diagnostics.
- To review a diff or share long notes, write them to a file and pass its absolute path in `attachments` rather than pasting them into `prompt`. When you will process or keep a long result rather than read it, pass `saveTo` (or `saveDir` on `spawn_batch`); results then show `savedTo`.
- `answerState` on a finished result (`missing`, `partial`, `narration`) means the text is not a usable conclusion; `follow_up` for one. Its absence is not a guarantee.
- Match the prompt to the model: give fast, small models a bounded checklist (what to grep, what to compare, a tool-call cap); give open-ended bug hunts to stronger reasoning models. `models` lists each model's accepted `thinking` levels.
- Permit and select `codemode` for scripted batch reads. For team dispatch, targeted follow-ups and synthesis, pass `coordinator: {tasks: [...]}`; parent prompt/tools default automatically. Members select exact `tools` plus `mcpServers` with direct exposure. See the [team workflow](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/blob/main/docs/workflows/codemode-coordinator.md). Set `coordinator.saveDir` to keep a `reportIndex` for cross-window report lookup; it may be stale and does not restore memory-only teams.
- Models do not count their own tool calls, so "at most N calls" in a prompt is not kept; pass `maxToolCalls` instead, with headroom (reviews often need 30-40).
- Budget turns with headroom. The last turn has no tools and asks for a conclusion from available evidence; timeouts, provider/auth errors or cancellation can still interrupt it. `usage` in the result shows tokens and cost.
- While running, `idleMs` is the time since the delegate's last event and `phase` is `model`, `tool` or `agent`. A long `idleMs` in phase `model` is slow reasoning or a hung request; `steer` lands only after the current turn, so decide whether to wait or `abort`.
- For authorized implementation, select the needed server-permitted write tools and keep work within the user's scope.
- Keep the returned `sessionId`; loop `wait` with `until: "settled"` until finished. Answer pending questions using `questions[].id` as `answer.requestId`, then wait again.
- For independent tasks, use `spawn_batch`; for multiple angles on the same material, collect facts in a parent first, then batch with `forkFrom`. Wait with `sessionIds`, answer questions, then continue with returned `continueIds` until none remain.
- Follow `nextAction`: `wait` to keep collecting, `answer` to resolve pending questions, `finish` when this run ends—not necessarily successfully; check `state`, `error`, `termination` and the result.
- Use `steer` while running, `follow_up` when finished; fork to change model/tools or create an independent branch. Follow-ups keep remaining quotas; pass `maxTurns`/`maxToolCalls` to renew them. Forks start fresh.
- Cancelling `wait` only stops waiting; use `abort` to stop the delegate.

## Recovery and handoff

- Sessions are in memory by default. Set `durable: true` at creation for restart recovery or cross-window continuation; retained history is required.
- Recovery still obeys run limits, including downtime; persistence does not mean execution continues without a running bridge.
- When asked to hand over, call `handoff` with `action: "save"`, the original `cwd`, `sessionId`, and your own `goal`, `completed`, and `next` notes.
- When asked to resume, call `handoff` with `action: "read"` and the project `cwd`; follow `resumeHint` and `howToResume`, without spawning duplicate work.
- Reading a note does not take ownership. Cross-window continuation needs the same local state and retained task and note; a live owner must release the task first.

- For interrupted tools with unknown side effects, inspect external state before retrying; never blindly replay them.
- Verify the delegate's findings, cited files, changes, and test evidence before reporting completion; distinguish confirmed results from unresolved claims.
