# Worker lifecycle

Read this before changing `src/pi/worker.ts` or `src/durable.ts`. It describes the current
implementation; `sessionId` identifies a conversation, and each `follow_up` starts another run.

## Where changes belong

- `src/tools/`: MCP schemas and result formatting.
- `src/core.ts`: execution operations and waits; hides terminal states while finalization is pending.
- `src/registry.ts`: capacity, session lookup, recovery claims and eviction.
- `PiWorker`: Pi SDK events, run state, cancellation and checkpoint contents.
- `MemoryJob` / `DurableJob`: execution storage. Memory saves are no-ops; durable saves commit to SQLite.

## Starting and finishing a run

`start()` creates the SDK session, binds extensions, opens the job and installs the awaited
journal listener before prompting Pi. `beginDurable()` is shared by memory and durable workers and by follow-ups:

```text
check provider -> recheck cancellation -> job.begin()
  -> track(): prompt() -> waitForIdle()
  -> final checkpoint -> job completion -> recordFinal() in catalog
```

Authentication and task creation both yield. Recheck cancellation after them; the `executions`
counter prevents an older cancelled startup from resuming a newer follow-up.
For durable jobs, creating a task and updating `CurrentTask.taskId` share one transaction.
The catalog is marked unfinished before that transaction; its final snapshot is written after completion.

`state === "done"` alone does not mean the result is committed. `isActive` also includes
`settling` and `abortPromise`; core reports `running` until finalization finishes.
`agent_end` alone is insufficient too: SDK listeners and automatic retries may still be pending.

Turns accumulate across follow-ups; the time budget restarts per run. Recovery keeps the run's
original clock, so downtime counts. The last turn has no tools. Native MCP registration is async:
the `context_with_system` hook also removes tool declarations from the final provider request.

## Event ordering and persistence barriers

The installed SDK awaits `session.agent.subscribe()` listeners. Its own session listener runs
first, so the journal sees `message_end` **after** the message enters `SessionManager`.
Public `session.subscribe()` callbacks run earlier and update the worker's trace/state.

| Event | What the journal must retain |
| --- | --- |
| `turn_start`, `turn_end` | Current turns and run state |
| `tool_execution_start` | Call intent committed before the SDK executes the tool |
| `tool_execution_end` | Completed result staged in `results` until its transcript message exists |
| `message_end` | Updated session entries; a `toolResult` clears its staged result and nested descendants in the same save |
| `agent_end` | Latest checkpoint, before job finalization |

Native nested calls bypass the agent subscriber. Their awaited `tool_call` hook commits intent;
`tool_execution_end` stages and saves the result. Keep both barriers. A global Pi update must
preserve these SDK ordering contracts; see `recovery.mjs` and `native-recovery.mjs` below.

## Cancel, suspend and resume

- `abort()`: sets `aborted`, resolves dialogs, saves state and drains SDK abort. The capacity slot
  stays occupied until `isActive` is false. Cancelling `run` aborts its worker; cancelling `wait` only ends that wait.
- `suspend()`: sets `suspended` to block further tool admission, drains SDK abort **while recording
  results**, saves the final checkpoint, then sets `recordingStopped`, closes the job and releases ownership.
  Keep `suspended` separate from `recordingStopped`: in-flight results must still be saved.
- Recovery rebuilds the transcript from saved entries and staged results. Missing results become
  unknown-outcome messages: external effects may already have happened, so never blindly replay the call.
  A committed answer or exhausted budget can finish recovery without provider authentication.
- Accepted steering stays pending until its user message is recorded. Recovery combines it into
  `recoveryInput`; only the matching `message_end` removes that input's steering from the queue.

## Tests to consult

All paths below are under `test/`; use temporary state as `offline.mjs` does.

| Change | Relevant tests |
| --- | --- |
| Startup cancellation, stale startup | `start-cancel.mjs` |
| Completion visibility, immediate follow-up | `wait-finalization.mjs` |
| Recovery, steering admission, tool barriers | `recovery.mjs`, `native-recovery.mjs` |
| Shutdown during execution | `pause-race.mjs` |
| Memory checkpoint overhead | `memory-checkpoint.mjs` |
| Turn limits and async native tool registration | `final-turn.mjs` |
