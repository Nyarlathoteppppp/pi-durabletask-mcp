# Worker lifecycle

Read this before changing `src/pi/worker.ts` or `src/durable.ts`. It describes the current
implementation; `sessionId` identifies a conversation, and each `follow_up` starts another run.

## Where changes belong

- `src/tools/`: MCP schemas and result formatting.
- `src/core.ts`: execution operations and waits; hides terminal states while finalization is pending.
- `src/registry.ts`: capacity, session lookup, recovery claims and eviction.
- `PiWorker`: Pi SDK events, run state, cancellation and checkpoint contents.
- `WorkerRun` (`src/pi/run.ts`): transient control for one run: timers, provider/retry flags,
  cancellation, finalization, completion, budget boundaries and the current run's successful edit/write receipt.
  Conversation entries and tool results stay in `PiWorker`. Receipt paths come from raw start-event
  arguments, not clipped diagnostic JSON; successful end events update them before checkpoints.
  Authentication refusal keeps the previous receipt; accepted follow-ups clear it. Recovery restores
  it from the snapshot, while forks copy only transcript entries and start with an empty receipt.
- `MemoryJob` / `DurableJob`: execution storage. Memory saves are no-ops; durable saves commit to SQLite.

## Starting and finishing a run

`start()` creates the SDK session, binds extensions, opens the job and installs the awaited
journal listener before prompting Pi. `beginDurable()` is shared by memory and durable workers and by follow-ups:

```text
check provider -> recheck cancellation -> job.begin()
  -> track(): prompt() -> waitForIdle()
  -> final checkpoint -> job completion -> recordFinal() in catalog
```

`beginDurable()` creates a `WorkerRun` before authentication. Authentication and task creation
both yield. Recheck cancellation after them; callbacks capture the run and compare it with
`currentRun` before changing worker state. Old callbacks clear only their own timers/finalization,
so they cannot finish, cancel or reset a newer follow-up. Session event listeners remain shared:
in-flight tool results still belong to the conversation and must be recorded.
For durable jobs, creating a task and updating `CurrentTask.taskId` share one transaction.
The catalog is marked unfinished before that transaction; its final snapshot is written after completion.

`state === "done"` alone does not mean the result is committed. `isActive` also includes
the current run's `settling` and `abortPromise`; core reports `running` until finalization finishes.
The public `run` promise includes job completion and final catalog writing. Creation failures
clear `settling`; final catalog failures become an `error` state without discarding the answer
or rejecting the completion promise.
`agent_end` alone is insufficient too: SDK listeners and automatic retries may still be pending.

Counts accumulate across follow-ups. `WorkerRun.budget` holds quotas and their cumulative start
counters. A follow-up's explicit `maxTurns`/`maxToolCalls` stages a renewal only for that dimension after auth;
omitted dimensions keep their boundary. The new task's initial snapshot persists `limits` and
`budgetStart` atomically with task creation. Creation failure before prompting restores the prior
budget/result. The live quota changes only when task creation succeeds (or its committed executor
starts first); cancellation during creation cannot write a provisional quota to the old task.
Tools are reactivated from original grants only when the task executes. Old snapshots
without `budgetStart` use zero origins. Recovery restores these counters, never renews them.
The time budget restarts per run. Recovery keeps the run's
original clock, so downtime counts. The last turn has no tools. Native MCP registration is async:
the `context_with_system` hook also removes tool declarations from the final provider request.

Forks copy a settled transcript into a new SDK session; they do not restore parent control state.
The SDK creates a fresh header, and the child's budgets and tool trace start empty. Inherited
usage remains in the transcript for SDK context accounting; persisted `usageBaseline` is subtracted
only from the child's reported bill. A durable fork commits its initial `ForkSeed` doc before
publishing the catalog row. Creating the first task and clearing that seed share one transaction.

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
`tool_execution_end` stages and saves the result. Keep both barriers. A Pi update must
preserve these SDK ordering contracts; see `recovery.mjs` and `native-recovery.mjs` below.

## Cancel, suspend and resume

- `abort()`: sets `aborted`, resolves dialogs, saves state and drains SDK abort. The capacity slot
  stays occupied during both checkpointing and SDK drain, even if saving fails. Explicit callers
  receive the save error; timer/event cancellations retain it as a warning. Cancelling `run`
  aborts its worker; cancelling `wait` only ends that wait.
- `suspend()`: sets `suspended` to block further tool admission, drains SDK abort **while recording
  results**, saves the final checkpoint, then sets `recordingStopped`, closes the job and releases ownership.
  Keep `suspended` separate from `recordingStopped`: in-flight results must still be saved.
- Recovery rebuilds the transcript from saved entries and staged results. Missing results become
  unknown-outcome messages: external effects may already have happened, so never blindly replay the call.
  A committed answer or exhausted budget can finish recovery without provider authentication.
  An assistant message ending in `stop` or `length` with no pending steering is already an answer;
  recovery records `length` as `done` with `answerState: partial`, without another model request.
- Accepted steering stays pending until its user message is recorded. Recovery combines it into
  `recoveryInput`; only the matching `message_end` removes that input's steering from the queue.

Failed recovery uses `releaseRecovery()` to dispose the SDK, close the job without resetting
attempts, then release ownership. A native transport shutdown failure is recorded and job cleanup
still runs. If the job itself cannot close, keep ownership and retain the worker's error for
diagnosis; `closing` alone does not confirm the Harness closed. Both lazy loading and background
recovery use this path. `RecoveryStopped` keeps ownership as before.

Ordinary unload and forget also keep a diagnostic worker if executor cleanup fails while
its durable row remains. Eviction/sweeps skip it, and follow-up is blocked with
`cleanup_failed`. Native shutdown rejection is recorded without skipping job close.
The installed durable SDK caches its close promise, including rejection. A failed
executor close is diagnostic, not automatically retryable: inspect the error and
restart the host to release process locks rather than force-unlocking a live executor.
Tool results are correlated only by SDK `toolCallId`, including parallel/nested calls;
never guess a write's success from its tool name.

## Tests to consult

All paths below are under `test/`; use temporary state as `offline.mjs` does.

| Change | Relevant tests |
| --- | --- |
| Startup cancellation, stale startup | `start-cancel.mjs` |
| Run identity, failed creation, cancellation/final catalog write errors | `worker-run.mjs` |
| Completion visibility, immediate follow-up | `wait-finalization.mjs` |
| Recovery, steering admission, tool barriers | `recovery.mjs`, `native-recovery.mjs` |
| Unload/forget cleanup failure and ownership diagnostics | `unload-failure.mjs`, `unload-race.mjs`, `recovery-failure.mjs` |
| Shutdown during execution | `pause-race.mjs` |
| Memory checkpoint overhead | `memory-checkpoint.mjs` |
| Fork isolation, inherited configuration, usage and bootstrap recovery | `fork.mjs`, `fork-seed.mjs` |
| Turn limits and async native tool registration | `final-turn.mjs` |
