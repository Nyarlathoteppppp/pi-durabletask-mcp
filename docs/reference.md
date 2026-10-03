# Reference

[Quick start](../README.md) · [简体中文](../README.zh-CN.md) · Tools, configuration, recovery, and development details.

## Tools

| Tool          | Purpose                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `init`        | Optional setup diagnostics: models, provider authentication, permissions and budgets. OAuth credentials may refresh. |
| `spawn`       | Delegate in the background. Returns `sessionId` immediately. **Use this by default.**                                                   |
| `spawn_batch` | Fan out up to the configured batch limit (default 4). Validated first, so nothing starts if one task is bad.                           |
| `run`         | Delegate and block until done. For quick questions only.                                                                                |
| `status`      | State, turns, tools used, latest text, and pending questions.                                                                           |
| `wait`        | Wait up to 55 seconds for progress, pending questions or completion. Cancelling this call leaves the worker running. |
| `steer`       | Redirect a running agent. Lands after its current tool call.                                                                            |
| `follow_up`   | Give a finished delegate another turn. It keeps everything it read, so you do not re-explain the task.                                   |
| `answer`      | Answer an actual pending extension UI question from `status` or `wait`; use `questions[].id` as `requestId`. |
| `abort`       | Stop a session; partial output stays readable.                                                                                          |
| `models`      | List models this delegate may use.                                                                                                      |
| `sessions`    | List sessions, running and finished. Filter by `state`, expand with `verbose`.                                                          |
| `forget`      | Drop a finished session from history, freeing its id.                                                                                   |

## Agent instructions

Tools work immediately after the MCP connection is established. For clients that need
workflow guidance, add this short block to their skill, `AGENTS.md` or `CLAUDE.md`:

```text
Use Pi for bounded delegation; put the task's context and constraints in the prompt.
Prefer spawn with an absolute repository cwd; omit model/tools for configured defaults and read-only tools.
Use models to choose an alternative model; init is optional setup diagnostics.
Use wait with prior turns as afterTurns and toolCallCount as afterToolCalls.
Answer pending questions using questions[].id as requestId before waiting again.
Use steer while running and follow_up when finished, while the session remains retained.
Memory sessions live in this server; use durable:true for restart recovery and disk retention.
Cancelling run aborts its delegate; cancelling wait only ends the wait.
```

Tool annotations describe read and mutation behavior; clients decide how to use the hints.
The stdio entry point runs recovery before connecting. Code embedding `createServer()` owns
startup recovery explicitly; `init` does not start or recover tasks.

## Other MCP clients

```json
{
  "mcpServers": {
    "pi": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/pi-durabletask-mcp/dist/index.js"]
    }
  }
}
```

The server uses Pi's configured default model unless `PI_DELEGATE_MODEL` or the call's
`model` selects another one. If your client launches without a Node.js `PATH`, use the
absolute path to `node` in its `command`. Keep the server key short because it prefixes
tool names, for example `mcp__pi__spawn`.

## Traceability

`spawn` and `run` both accept your own `id` and a free-text `label`:

```json
{
  "id": "search-audit-01",
  "label": "what ONNX removal left behind",
  "prompt": "...",
  "model": "opencode-go/deepseek-v4-flash"
}
```

Ids are `[A-Za-z0-9._:-]`, 1-64 chars, must start alphanumeric, and must be unique among live
sessions. Omit for a UUID.

Finished sessions stay readable via `status` and `sessions` instead of vanishing, so you can go
back and check what a delegate actually did. The newest `PI_DELEGATE_HISTORY` (default 50) stay
loaded; durable ones beyond that stay on disk until retention removes them; `forget` drops one early.

Polling must not cost the caller much context, so `status` and `wait` are compact by default:
`toolCalls` holds the last 5 calls with arguments cut to 120 characters, `toolCallCount` is the
total, and `notices` holds the newest 5. Pass `afterToolCalls: <toolCallCount>` to `wait`.
`verbose: true` returns the full ordered trace, every notice, and call ids and results:

```json
{
  "seq": 1,
  "id": "call_467b4bb4…",
  "name": "bash",
  "state": "ok",
  "ms": 10,
  "args": "{\"command\":\"echo hello-trace\"}",
  "result": "hello-trace\n"
}
```

Arguments and results are clipped (`PI_DELEGATE_TRACE_ARGS`, `PI_DELEGATE_TRACE_RESULT`) with the
dropped length recorded, so one `read` of a large file cannot flood your context.

### Provider failures

Pi retries transient provider failures itself (stream drops, 429/5xx, timeouts), following
`retry` in Pi's settings (default 3 retries with backoff). Each retry appears as a notice,
`provider retry 1/3 in 2000ms: <error>`, and a run that fails after retrying says so in `error`.
Retrying the same provider by hand rarely helps after that; choose another.

Optional `init` resolves the credentials of every provider a delegate may use, as a request would,
refreshing OAuth tokens that would expire within the longest delegate run. Providers that fail
are listed under `failingProviders` with the reason and their models are not offered; `spawn`,
`run` and `spawn_batch` refuse a model of such a provider before starting anything. API keys
are checked for presence only, so a revoked key still surfaces on the first request.

### Search

The delegate's `grep` uses ripgrep from Pi's tool directory (`<agent dir>/bin/rg`, where Pi
downloads it) or else from the MCP server's PATH, which MCP hosts often start without the login
shell's PATH. `init` reports which one under `search.ripgrep`, or how to fix a missing one.

## Giving a delegate another turn

A finished delegate can continue with `follow_up`, keeping what it already read in context.
Memory sessions can continue while retained in the running server; durable sessions persist
across restarts until retention removes them:

```json
{ "sessionId": "search-audit-01", "prompt": "Now check whether the build files reference it too" }
```

```
{ "sessionId": "search-audit-01", "state": "running", "turnsSoFar": 1 }
```

The delegate picks up where it left off. It still holds the files it read on the first turn, so
the second question costs one model call rather than a fresh session re-reading the repository.

This is the cheap way to have a conversation with a delegate. Spawning a fresh one means
re-explaining the task and paying for it to re-read the same files, and its answer arrives
with none of the reasoning that led there.

Turns are cumulative across follow-ups, and `follow_up` is refused once `maxTurns` is used up.
The wall-clock limit (`maxDurationMs`) applies to each run instead: the spawn and every
`follow_up` get the full limit, so a durable delegate kept for days can still be continued.
Time a run spends interrupted by a server restart counts against that run.

`follow_up` refuses a delegate that is still working, because redirecting one mid-task is
what `steer` is for. The two are not interchangeable: `steer` lands between tool calls on a
running agent, `follow_up` starts a new turn on a finished one.

## Fanning out

`spawn_batch` starts a whole batch in one call. Tasks inherit the batch-level `model`, `thinking`,
`cwd`, `tools` and `extensions`, and override them individually where they need to:

```json
{
  "idPrefix": "audit",
  "model": "opencode-go/deepseek-v4-flash",
  "thinking": "low",
  "cwd": "/repo",
  "tools": ["ls"],
  "tasks": [
    { "prompt": "What still imports onnxruntime?", "label": "imports" },
    { "prompt": "Which build files still reference ONNX?", "label": "build" },
    {
      "prompt": "Any ONNX model files left on disk?",
      "label": "artifacts",
      "model": "opencode-go/ox-alpha-free"
    }
  ]
}
```

That names them `audit-01`, `audit-02`, `audit-03` and returns in a few milliseconds, since
launching a delegate does not wait for it to think.

The batch is validated before anything starts: id format, ids duplicated inside the batch, ids
already live, blocked tools, and every model name. One bad task fails the call and launches
nothing. Half a fan-out is the worst outcome, because you pay for the delegates that did start
and still have to work out which ones did not.

Poll the whole batch with one `sessions` call rather than one `status` per delegate. Drop to
`status` only for the delegate you actually want to read. `steer` and `abort` stay per session.

## Picking a model per call

`model` on any call overrides `PI_DELEGATE_MODEL`. An unresolvable name is a hard error, never a
silent fallback to the default model, because a silent fallback is how you end up billing a model
you never asked for.

Which names resolve is decided by pi's own `enabledModels` scope, which this server enforces
rather than merely displays:

```
opencode-go/deepseek-v4-flash  -> ok      (listed in enabledModels)
opencode-go/glm-5.3            -> refused (out of scope)
knowns-hub/claude-opus         -> ok      (custom provider, see below)
```

**Custom providers bypass the scope.** Any model served by a provider declared in
`~/.pi/agent/models.json` is offered even when `enabledModels` does not name it, on the grounds
that declaring a provider by hand is already an intent to use it. This is why the list can be
much longer than `enabledModels`: three entries in the scope plus two custom providers can easily
mean fifteen offered models. `init` says so explicitly in `models.scopeNote` when it applies.

Two switches change that:

| | Effect |
|---|---|
| `PI_DELEGATE_STRICT_SCOPE=1` | Honour `enabledModels` exactly. The custom-provider bypass is dropped. |
| `PI_DELEGATE_IGNORE_SCOPE=1` | Drop scoping altogether. Every authenticated model is usable. |

Call `models` to see what is actually reachable under whichever setting is in force.

`PI_DELEGATE_MODEL_ALLOWLIST` adds an MCP-only exact-ID boundary after pi's own scope. It does not
change interactive pi's `enabledModels` or model picker. This is useful when the main pi installation
has a broad catalog but the MCP host should only route delegates to a small approved pool:

```json
"env": {
  "PI_DELEGATE_MODEL_ALLOWLIST": "your-provider/model-a,your-provider/model-b"
}
```

`PI_DELEGATE_MODEL_DENYLIST` excludes exact model refs or `*` patterns from the delegate catalog.
When combined with `PI_DELEGATE_IGNORE_SCOPE=1` and no allowlist, the server follows every model
available from pi's authenticated providers except the matching exclusions:

```json
"env": {
  "PI_DELEGATE_IGNORE_SCOPE": "1",
  "PI_DELEGATE_MODEL_DENYLIST": "anthropic/*,openai-codex/*,dragon/grok-4.6"
}
```

Every launch may also pass `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
Omit it to let pi apply its configured/default level. A non-`off` level that the selected model does
not declare is rejected before a session starts instead of silently becoming `off`. Responses and
status snapshots report the effective level.

## Status line

Claude Code allows exactly one `statusLine` command, so `pi-delegate-statusline` wraps whatever
you already run and appends a segment showing this workspace's delegates:

```json
{
  "statusLine": {
    "type": "command",
    "command": "PI_DELEGATE_STATUSLINE_WRAP=ccstatusline pi-delegate-statusline",
    "refreshInterval": 10
  }
}
```

Drop `PI_DELEGATE_STATUSLINE_WRAP` to print the pi segment alone.

```
π ▸ audit engine·t1·12s audit index·t2·8s   running, with turn counts and elapsed time
π ▸ migrate·t7·3m04s ?1 waiting             one delegate is blocked on a question
π ✓2                                        finished, nothing running
```

### Which delegates belong to which session

Filtering by directory is not enough: two Claude Code sessions open on the same repository
would show each other's delegates. Attribution uses process lineage instead.

The MCP host spawns one server per session, so the server records `process.ppid`, the host's
pid. The status line, spawned by that same host, walks its own ancestry and keeps only the
state files whose `hostPid` it finds there. Same repo, two sessions, no crosstalk. The
directory filter remains as a fallback for state files written before this existed.

State lives in `$XDG_STATE_HOME/pi-delegate-mcp/<pid>.json` (`PI_DELEGATE_STATE_DIR` to
relocate). Files are pruned when their process is gone, `ESRCH` only, since `EPERM` means the
process is alive under another user. Servers also exit on their own when stdin closes or the
host pid disappears, so a host that dies without closing the transport leaves nothing behind.

## Read-only by default

Tools are locked to `read, grep, find, ls` at session construction. Anything else is refused
before a session is even created.

Omit `tools` to use those defaults. Pass `tools: []` to disable all tools for a delegate.
Recursive `grep` excludes the credential paths covered by the secret-path guard, including
`.env` and private configuration directories, even when searching their parent directory.
The protected grep uses `rg` from the server's `PATH`.

To widen that, name the extra tools on the server:

```json
"env": { "PI_DELEGATE_ALLOW_TOOLS": "bash" }
```

or `PI_DELEGATE_ALLOW_WRITE=1` to permit everything.

**`bash` is not a middle ground.** pi ships no permission system, so a delegate holding `bash`
can write files, delete them, and reach the network regardless of whether `write` and `edit` are
on its list. Refusing those two while allowing `bash` records your intent; it does not enforce
anything. Claude Code's permission prompts and hooks never see what pi does. If you need a real
boundary, run this server inside a container.

## Recovery after a server restart

### SDK updates on this machine

The install hook links the bridge's SDK dependency to the globally installed Pi package
from `npm root -g`. `pi update --all` therefore updates the SDK a new bridge process will
load, without a separate bridge SDK update. Reconnect the MCP server after updating;
already running Node processes must not hot-swap their loaded modules. `init.pi.sdkVersion`
and `init.pi.sdkPath` report the code actually loaded. `npm run sdk:link` restores the link
if an install was run with lifecycle scripts disabled. Install global Pi before the bridge.

`@earendil-works/pi-durable` remains an independent package; it is not updated by the Pi CLI.
After updating global Pi, run `npm test` in the bridge checkout, then reconnect the MCP
process. This checks the awaited event-callback contract used by the tool execution barriers.
`@earendil-works/pi-durable` stays pinned separately in `package.json`.

### Task recovery

The bridge uses Pi 1.0's `@earendil-works/pi-durable` with a custom SDK task. It preserves
the existing AgentSession model configuration, extensions, tools, and secret-path guard.
Each significant agent event commits one atomic checkpoint containing the full SDK session
entries, worker status, completed tool results, and queued steering instructions.
The tool-start checkpoint is committed before the SDK executes the tool.
Completed results are held separately only until their `toolResult` message is saved;
the same commit then removes the temporary copy. A Session document tracks the current
task ID, committed atomically with each initial/follow-up task creation. Existing stores
without that pointer are migrated once by selecting their latest task.

State is stored under `PI_DELEGATE_STATE_DIR/durable/v2/` (by default
`~/.local/state/pi-delegate-mcp/durable/v2/`). It contains conversation and tool output data.
Directories are private and SQLite files are mode 600. Each delegate has its own SQLite
store under `jobs/`, listed in a shared `catalog.sqlite`. Recovery is local to this machine
and Pi agent directory.

#### Ownership

Each store has exactly one owning MCP process, which holds an exclusive SQLite lock on
`ownership/<key>.sqlite` for as long as it owns the store. The kernel releases the lock when
the process dies, so a dead owner's stores are claimed by exactly one other process, and a
reused PID cannot keep them. A process that is alive but stopped or hung keeps its lock and is
never taken over: kill it to release its delegates. This trades automatic liveness for never
having two executors of one task. The catalog's `pid` column is diagnostic only.

- `STATE_DIR` must be on a local filesystem. Network filesystems may not honour the locks.
- Lock files are opened only through `node:sqlite` by `src/ownership.ts`, and are never
  deleted. Deleting an open lock file would let the next opener lock a new file at the same
  path. `forget` removes the catalog row and store, then releases the lock, and leaves the
  small lock file behind.
- A delegate that cannot be recovered (for example, its stored tools are no longer permitted)
  is shown with `state: "error"` and the reason. Each new process that claims it shows it
  again, rather than silently dropping it, until you `forget` it.
- A claim of a task that has not finished a turn since its last claim counts as a recovery
  attempt. After `PI_DELEGATE_MAX_RECOVERY_ATTEMPTS` (default 3) such claims, the delegate is
  reported as an error instead of being resumed, so a task that crashes its host on recovery
  cannot crash every host in turn. Inspect it, then `forget` it. Completing a turn, a clean
  shutdown, or loading finished history resets the count.

#### Durable is opt-in; retention

Delegates are in memory only by default. Such a delegate writes no catalog row, lock or store,
supports `status`, `wait`, `steer` and `follow_up` while this MCP process lives, and is gone
when it exits; it is never recovered. That suits short, cheap, re-runnable work such as reviews,
searches and model comparisons. Pass `durable: true` on `spawn`, `run` or `spawn_batch` for long
work, external side effects, work that must survive a restart or be followed up later, or when
the user asks for it. `retentionDays` (1-365) sets how long that one is kept; it is refused
without `durable: true`.

Durable delegates are kept on disk after they finish, then deleted automatically:

- `PI_DELEGATE_HISTORY` limits how many finished delegates each process keeps loaded in
  memory. Unloading one only frees memory: a durable delegate stays on disk and appears in
  `sessions` under `stored`.
- Any process can read a finished durable delegate with `status` or `wait`, including one
  another live process has loaded: its final state is recorded in the catalog, so reading
  loads nothing. `follow_up` loads it, which needs any process holding it to let go first.
- A finished delegate is deleted `retentionDays` after it last finished, or
  `PI_DELEGATE_RETENTION_DAYS` (default 7) when its spawn named none; `follow_up` restarts
  the clock.
- When job stores exceed `PI_DELEGATE_STORAGE_LIMIT_MB` (default 1024), the oldest finished
  delegates are unloaded and deleted early until the total is under the limit, whatever their
  `retentionDays`. This is a soft limit on the job stores only: the shared catalog, which holds
  each finished delegate's final state, is not counted.
- Unfinished delegates are never deleted, under any pressure. Neither are delegates another
  live process has loaded; that process applies retention to them itself.
- The check runs when a process starts and, at most once a minute, when a delegate finishes.
  It needs no background process. Lock files of deleted delegates are removed with them.
- Recovery at startup resumes only unfinished delegates. Finished ones are not loaded until
  someone asks for them, so a new process does not take over every other process's history.

`durable/v2/` is ownership protocol 2, recorded in the catalog's `meta` table; a host refuses a
catalog with another protocol. Builds before protocol 2 used `durable/catalog.sqlite` and
`durable/<key>/` with PID ownership. The two namespaces never see each other's jobs, so old
and new builds running at the same time cannot both own a store. Delegates left in the
protocol 1 namespace are recovered only by old builds. Once no old build is running,
`durable/catalog.sqlite` and the `durable/<uuid>/` directories can be deleted.

New stdio server processes automatically recover abandoned delegates before connecting.
Original session IDs, history, model selection, turn budgets, and start
times are retained; downtime counts toward the original wall-clock deadline. Additional
abandoned tasks are recovered as concurrency slots become available. Use `sessions`,
`status`, and `follow_up` as usual. `forget` removes persisted records at once; otherwise
retention removes them (see below).

Shutdown signals the SDK first, records in-flight tool completions until it becomes idle,
then saves the final checkpoint and closes storage. Recovery steering is retained until
its user message and queue removal are committed together, including a second crash
before that message is admitted. Explicit `abort` and caller cancellation remain terminal across
restart. Already committed tool results are reused. If a crash happens after a tool effect
but before its result is committed, recovery inserts an unknown-outcome error instead of
automatically replaying the call, and asks Pi to inspect external state before retrying.
This is not an exactly-once guarantee for external effects. In-flight model streams restart
from committed history, and extension dialogs interrupted by restart may need to be asked
again; arbitrary extension timers and private runtime state are not restored.

Sessions created by an older bridge process before this feature are not recoverable.
Reconnect the MCP server to load the new build. Normal terminal Pi sessions are unaffected.

`npm test` includes local fake-provider tests that kill the bridge with SIGKILL, restart
it, and verify committed results, interrupted effects, concurrent claimers, live owners,
queued steering, graceful shutdown, terminal aborts, deadlines, persistent forget, and follow-up.
They also cover running/completed follow-up restarts, a second crash before steering
admission, successful tool results during pause, and the awaited tool-start callback contract.
Native tests cover exact tool permissions, direct/codemode/deferred exposure, explicit
server selection, batch inheritance, transport cleanup, parallel nested results, and
the execution barrier and reconnection after a crash.

## Web search and other extension tools

pi's own tools are `read`, `grep`, `find`, `ls`, `bash`, `powershell`, `write`, `edit`. There is no
search and no fetch among them. Those come from pi extensions, which register their own tools, and a
delegate can use them.

Set `extensions: true` on the call and permit the tool names on the server:

```json
"env": { "PI_DELEGATE_ALLOW_TOOLS": "web_search,fetch_content" }
```

```json
{ "prompt": "Find the current Node LTS version and tell me just the number",
  "extensions": true, "tools": ["read", "grep", "find", "ls", "web_search"] }
```

```json
{ "seq": 1, "name": "web_search", "state": "ok", "ms": 2568,
  "args": "{\"query\":\"latest stable Node.js LTS version\",\"numResults\":5}" }
```

This is how you give a delegate network reach **without** handing it `bash`. `web_search` can search
and nothing else, and it passes through the same allowlist as every other tool, so the read-only
default is unchanged for calls that do not ask for it.

Which tools exist depends on what the user running the server has installed. `pi-web-access` provides
`web_search`, `fetch_content`, `source_check` and `get_search_content`. `pi-mcp-adapter` can expose configured MCP servers through an installed extension.
Pi's native MCP support is available independently through `nativeMcp`; see below.

**`extensions: true` trusts every installed extension, not just the one you wanted.** They load as a
set, they run with the full privileges of this server's process, and some open sockets and timers
that outlive the session. Turn it on per call, for the delegates that need it, rather than leaving it
on by default. It also costs real startup time, which is why it is off unless asked for.

## Native MCP

Pass `nativeMcp: true` and an explicit `mcpServers` list to `spawn`, `run`, or
`spawn_batch`. This works with `extensions: false`: only Pi's official MCP,
codemode, and tool-search factories are loaded. Unselected servers are not connected.
Server entries come from the Pi agent directory's `mcp.json`, with project entries
used only when Pi trusts that project. Disabled or unknown selections are rejected.

Authorize exact tool names in the bridge's environment, then request them in `tools`:

```json
"env": { "PI_DELEGATE_ALLOW_TOOLS": "codemode,tool_search,mcp__docs__search" }
```

```json
{
  "prompt": "Search the documentation for the timeout setting.",
  "cwd": "/path/to/repo",
  "nativeMcp": true,
  "mcpServers": ["docs"],
  "extensions": false,
  "tools": ["codemode", "mcp__docs__search"]
}
```

Use the names Pi assigns (`mcp__<server>__<tool>`); Pi sanitizes characters and may
shorten long names. For `direct` exposure, name the MCP tool in `tools`. For
`codemode` exposure, also name `codemode`; for `deferred` exposure, name `tool_search`.
The existing server permission list and SDK tool restriction apply to direct,
searched, and nested calls. `tools: []` starts no native transports and remains tool-free.
MCP annotations do not grant permission. A permitted MCP tool may write or act outside
`cwd`; select its capabilities deliberately. Codemode's separate model API is disabled
so scripts cannot bypass the delegate's model selection policy.

Nested calls commit intent before execution and full results before returning to the
script. Parent transcript commits remove the temporary child results atomically.
After a crash, the bridge reconnects selected servers and preserves committed child
results in the interrupted parent's error message. It does not replay the script;
unknown external effects require inspection. Remote server state is not checkpointed.
`forget` and shutdown close native transports. Host shutdown pauses execution; the
next bridge process resumes it.

Batch tasks inherit `nativeMcp` and `mcpServers` unless overridden. To disable native
MCP for one task in an enabled batch, pass `nativeMcp: false, mcpServers: []`.

## Configuration

| Env var                       | Default          | Meaning                                                                  |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `PI_DELEGATE_MODEL`           | pi's own default | Model used when a call omits `model`                                     |
| `PI_DELEGATE_MODEL_ALLOWLIST` | unset            | Exact `provider/modelId` values this MCP server may delegate to           |
| `PI_DELEGATE_MODEL_DENYLIST`  | unset            | Exact refs or `*` patterns excluded from the delegate catalog              |
| `PI_DELEGATE_ALLOW_TOOLS`     | unset            | Comma list of extra tools to permit, e.g. `bash`                         |
| `PI_DELEGATE_ALLOW_WRITE`     | unset            | `1` permits every tool                                                   |
| `PI_DELEGATE_HISTORY`         | `50`             | Finished sessions kept for review                                        |
| `PI_DELEGATE_TRACE_ARGS`      | `400`            | Max chars of tool arguments kept in the trace                            |
| `PI_DELEGATE_TRACE_RESULT`    | `600`            | Max chars of tool results kept in the trace                              |
| `PI_DELEGATE_BATCH_MAX`       | `4`              | Ceiling on tasks per `spawn_batch` call                                  |
| `PI_DELEGATE_MAX_CONCURRENT`  | `4`              | Hard ceiling across all active delegates in this server process          |
| `PI_DELEGATE_MAX_TURNS`       | `50`             | Absolute turn ceiling; per-call budgets may only lower it                 |
| `PI_DELEGATE_MAX_DURATION_MS` | `900000`         | Absolute wall-clock ceiling; per-call deadlines may only lower it         |
| `PI_DELEGATE_RUN_TURNS`       | `12`             | Default turn budget for blocking `run`                                   |
| `PI_DELEGATE_RUN_DURATION_MS` | `300000`         | Default wall-clock deadline for blocking `run`                           |
| `PI_DELEGATE_SPAWN_TURNS`     | `30`             | Default turn budget for `spawn` and `spawn_batch`                        |
| `PI_DELEGATE_SPAWN_DURATION_MS` | `600000`       | Default deadline for `spawn` and `spawn_batch`                           |
| `PI_DELEGATE_LIST_CAP`        | `60`             | Above this, `init` summarises models by provider instead of listing them |
| `PI_DELEGATE_STATE_DIR`       | XDG state dir    | Status-line state and durable task storage (local filesystem only)       |
| `PI_DELEGATE_MAX_RECOVERY_ATTEMPTS` | `3`        | Claims without progress before a delegate is reported instead of resumed |
| `PI_DELEGATE_RETENTION_DAYS`  | `7`              | Days a finished durable delegate is kept when its spawn sets no `retentionDays` |
| `PI_DELEGATE_STORAGE_LIMIT_MB` | `1024`          | Soft limit on job stores; above it the oldest finished are deleted early |
| `PI_DELEGATE_STATUSLINE_WRAP` | unset            | Status line command to wrap and append to                                |
| `PI_DELEGATE_STATUSLINE_LOG`  | unset            | File to append a timestamp to on every status line render, for debugging |
| `PI_DELEGATE_PROGRESS_MS`     | `15000`          | Progress notification interval during `run`                              |
| `PI_DELEGATE_IGNORE_SCOPE`    | unset            | `1` ignores pi's `enabledModels` scope, allowing any configured model    |
| `PI_DELEGATE_STRICT_SCOPE`    | unset            | `1` honours `enabledModels` exactly, dropping the custom-provider bypass |
| `PI_CODING_AGENT_DIR`         | `~/.pi/agent`    | Where pi's `auth.json` and config are read from                          |

## Long-running work

The MCP TypeScript SDK defaults to a **60 second** request timeout, which a real task will blow
through. Three defences, in order of preference:

1. Use `spawn` + `status`. Nothing blocks, so no timeout applies.
2. `run` emits periodic progress notifications, which reset the host's timeout.
3. Raise the ceiling with `"timeout"` in `.mcp.json` or `MCP_TOOL_TIMEOUT` in the environment.

These transport timeouts are separate from the delegate safety budgets. `run` defaults to 12 turns
or 5 minutes; background sessions default to 30 turns or 10 minutes. At 75% of the turn budget, a
tool-using delegate is steered once to stop exploring and return its best conclusion. Reaching the
turn or time ceiling aborts the underlying pi session and records `termination.reason`, while keeping
the trace and any partial text. Cancelling a blocking `run` also aborts its underlying worker.

`CLAUDE_AUTO_BACKGROUND_TASKS=1` makes Claude Code background long MCP calls after ~2 minutes.
Note that progress notifications are discarded once a call is backgrounded, so pick (1) or (3),
not both.

## Auth

The server does not handle credentials. pi authenticates itself from `~/.pi/agent/auth.json`,
then environment variables. MCP hosts often launch servers with a **stripped environment**, so
prefer `auth.json` (run `pi` once and `/login`) over exporting keys in a shell profile.

## Development

```bash
npm install
npm run build       # tsc, src/*.ts -> dist/
npm run typecheck   # tsc --noEmit, strict
npm test            # typecheck, build, offline regressions and local-provider integration
npm run test:ci     # same suite, used by prepublishOnly
npm run bench:checkpoint # synthetic 0.1/1/5 MiB payloads, real DurableJob + SQLite
PI_DELEGATE_MODEL=xai/grok-4.7 npm run test:live  # real provider call; consumes quota
```

`npm test` and `test:ci` use temporary Pi configuration and a fake provider on loopback. They
need no account credentials and make no external model calls. The suite covers concurrent
reservations, duplicate IDs, cancellation during questions, complete replies, tool selection,
recursive secret exclusion, status publication, and actual MCP-to-Pi SDK session calls.
Recovery tests cover follow-ups interrupted or completed before restart, a second crash
before steering reaches the transcript, tool results completed during suspension, and the
awaited checkpoint barrier before tool execution.

`test:live` is a separate opt-in smoke test. Set `PI_DELEGATE_MODEL` to the exact registered
provider/model to test. It makes one tool-free completion and requires usable Pi credentials.
Older diagnostic scripts remain available individually; some use historical model IDs and
are not part of the offline suite.

| Path                 | What lives there                                     |
| -------------------- | ---------------------------------------------------- |
| `src/config.ts`      | Every environment variable, read in one place         |
| `src/permissions.ts` | The tool allowlist and the gate that enforces it      |
| `src/core.ts`        | Protocol-independent execution operations and waits   |
| `src/registry.ts`    | Session map, id claiming, history eviction, recovery  |
| `src/durable.ts`     | Durable task checkpoints, current task, catalog, recovery claims |
| `src/ownership.ts`   | Kernel-lock ownership of durable stores                 |
| `src/tools/`         | MCP schemas, annotations, result formatting and notifications |
| `src/pi/`            | Everything that touches the pi SDK                    |
| `src/statusline/`    | State file publishing and the status line binary      |

GitHub Actions runs the offline suite on Node.js 22 and 24 for pushes and pull requests.
The workflow does not publish an npm package.

### Execution core and MCP Tasks

Custom execution tools delegate to `src/core.ts`; the registry and `PiWorker` still own
sessions and lifecycle. The core returns ordinary data and accepts an `AbortSignal` and
an optional progress callback. MCP request metadata, notification methods and JSON content
wrappers stay in `src/tools/`. Storage, ownership, recovery and retention are unchanged.

`sessionId` remains the conversation identity; `follow_up` starts another run in that
conversation. Separate execution handles and their recovery mapping belong to the later
Tasks adapter and are not implemented in this extraction.

The installed MCP SDK is **1.30.0**. It exports the older `experimental/tasks` API tied
to protocol `2025-11-25`, not the current `io.modelcontextprotocol/tasks` extension.
The official extension's [TypeScript package](https://tasks.extensions.modelcontextprotocol.io/typescript/)
targets SDK v2. Until a compatible server API is available, this project exposes only
its existing custom tools. No Tasks wire protocol or dependency upgrade is added here.

The checkpoint benchmark uses temporary state and makes no model calls. It reports JSON
clone and end-to-end save median/P95 over 30 commits per size after 3 warmups. Save time
includes cloning. This is a single-worker synthetic microbenchmark, not a concurrency
or growing-history benchmark; use it to establish a baseline before changing storage.

Issues and pull requests are welcome. If you are reporting a delegate that misbehaved, the
`toolCalls` trace from `status` with `verbose: true` is the useful thing to attach.

## License

MIT
