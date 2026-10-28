<p align="center">
  <img src="https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durateam/main/docs/assets/hero-teams.svg" alt="pi-durateam — Split work across models. Bring findings together." width="100%" />
</p>

<div align="center">

**English** · [简体中文](README.zh-CN.md)

# pi-durateam

A team of [Pi](https://pi.dev) agents for Claude Code and Codex, on any provider, with runs built to finish.

[![npm](https://img.shields.io/npm/v/pi-durateam)](https://www.npmjs.com/package/pi-durateam)
[![CI](https://github.com/Nyarlathoteppppp/pi-durateam/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durateam/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[Quick start](#quick-start) · [Team](#team-several-models-on-one-job) · [MCP tools](#mcp-tools-per-delegate) · [Dura](#dura-runs-built-to-finish) · [Reference](docs/reference.md)

</div>

> Renamed from `pi-durabletask-mcp`: install `pi-durateam`. The old command still works; configuration, `PI_DELEGATE_*` variables, stored state and tool names are unchanged.

---

Your main agent plans, picks the models and judges the results. The reading, searching and cross-checking run on Pi delegates — Gemini, Grok, GPT, DeepSeek or any other provider Pi supports — and spend those quotas instead of your Claude Code or Codex one; what comes back is a compact status and the final report, or just a file path. In our own pre-release review, four agents read about two million tokens of this codebase on Gemini, Grok and a GPT model, and our Claude session received about 7 KB of reports.

- **team** — one task or several in parallel, the same question to several models, forks that read once and answer many questions, an opt-in coordinator, and MCP servers (read-only GitHub, a browser) granted per delegate.
- **dura** — every run has turn and time budgets and a last turn without tools, reserved for the answer. `maxToolCalls` adds an optional tool-call cap. Opt in to a soft deadline, model fallback on provider errors, and sessions that survive a server restart.

For example, ask your agent: *"Use Pi to review the attached diff with Gemini, Grok and GPT in parallel. Don't edit files. Report only real defects with file:line."* It calls `spawn_batch` with one shared `prompt` and three models, collects with `wait`, and gets three independent reports with token usage and cost.

## Quick start

**Requires macOS or Linux, Node.js 22.19+ and Pi.** CI runs Node.js 22 and 24 against Pi 1.0.0, 1.0.4, 1.1.0 and 1.3.0. Model calls use your own provider credentials.

**1 · Install Pi** (skip if you have it) and log in to a provider:

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi  # then /login, or configure a provider
```

**2 · Install pi-durateam:**

```bash
npm install -g pi-durateam@latest
```

<details>
<summary>Or install from source</summary>

```bash
git clone https://github.com/Nyarlathoteppppp/pi-durateam.git
cd pi-durateam && npm ci && npm run build
# below, use `node /absolute/path/pi-durateam/dist/index.js` instead of `pi-durateam`
```

</details>

**3 · Connect.** Claude Code:

```bash
claude mcp add --scope user pi -- pi-durateam
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.pi]
command = "pi-durateam"
```

The Codex desktop app starts MCP servers with a minimal `PATH` (no Homebrew or nvm directories), so it may find neither `pi-durateam` nor the `node` it runs on. The server then never starts and the session simply has no Pi tools. Use absolute paths there:

```toml
[mcp_servers.pi]
command = "/opt/homebrew/bin/node" # output of `which node`
args = ["/opt/homebrew/lib/node_modules/pi-durateam/dist/index.js"] # under `npm root -g`
[mcp_servers.pi.env]
PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" # inherited by what the server starts
```

Reconnect the MCP server after updating pi-durateam or Pi. [Other clients →](docs/reference.md#other-mcp-clients)

**4 · Try it:** "Use Pi to check the auth module for missing permission checks. Read only." `init` shows models, provider credentials and settings; `models` lists what delegates may use.

<details>
<summary>Optional: install the Agent Skill</summary>

The [skill](skills/pi-durateam/SKILL.md) teaches your agent the workflow. Put `SKILL.md` in your client's skills directory:

```bash
dir="$HOME/.claude/skills/pi-durateam" # Claude Code
# dir="$HOME/.agents/skills/pi-durateam" # Codex: use instead
mkdir -p "$dir"
curl -fsSL https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durateam/main/skills/pi-durateam/SKILL.md \
  -o "$dir/SKILL.md"
```

</details>

## Team: several models on one job

- **Delegate.** `spawn` starts one task in the background and returns a `sessionId` at once. `spawn_batch` starts up to 4 per call by default (`PI_DELEGATE_BATCH_MAX`) and checks every task first, so nothing starts if one is bad. `run` blocks, for quick questions. Collect with `wait` and `until: "settled"`.
- **One question, several models.** A batch-level `prompt` goes to every task; each task names its `model`, and its own `prompt` is appended. Different model families miss different things, but agreement is not proof: [verify findings](docs/workflows/review-and-synthesize.md) before acting.
- **Read once, ask many.** `forkFrom` starts new tasks from a finished session's transcript, including the files it already read; each fork gets fresh budgets.
- **Steer and continue.** `steer` a running delegate, `answer` its questions, `follow_up` a finished one (it keeps what it read), `abort` when needed. `status` reports `idleMs` and `phase`, which tell slow reasoning from a hung request.
- **Material in, reports out.** `attachments` passes a diff or notes by absolute path; `saveTo` / `saveDir` write long reports to files and return the path; `usage` gives tokens and cost.
- **Coordinator (opt-in).** Pass a `coordinator` plan to `spawn`: a Pi coordinator dispatches your members, can ask one a targeted follow-up, and writes one synthesis that cites the original reports. Requires `codemode` in `PI_DELEGATE_ALLOW_TOOLS`. For most work `spawn_batch` and your own judgment are simpler. [Workflow →](docs/workflows/codemode-coordinator.md)

## MCP tools per delegate

A delegate can use MCP servers from Pi's `mcp.json` — read-only GitHub, Serena, a browser, web search — selected per task; nothing is on by default. Add the server to `~/.pi/agent/mcp.json`, permit its exact tool names in pi-durateam's environment (`PI_DELEGATE_ALLOW_TOOLS="mcp__github__get_file_contents,mcp__github__search_code"`) and reconnect. Then select them per call:

```json
{
  "cwd": "/absolute/repo",
  "nativeMcp": true,
  "mcpServers": ["github"],
  "tools": ["mcp__github__get_file_contents"],
  "prompt": "Read package.json of OWNER/REPO with GitHub MCP and report its version."
}
```

- Only the servers in `mcpServers` are connected. Of their tools, the delegate gets only the `mcp__<server>__<tool>` names listed in `tools` and permitted by `PI_DELEGATE_ALLOW_TOOLS`; selecting a server never grants all of its tools.
- A call that selects servers but grants none of their tools is refused before anything starts — for example with `tools` omitted (the read-only default), or with only `codemode` or `tool_search`, which reach only tools named in `tools`. Granting only tools hidden in `mcp.json` is refused too. `tools: []` remains a tool-free run.
- The server's `exposure` in `mcp.json` does not matter to delegates: every tool named in `tools` is declared to the delegate directly, so you can keep servers `deferred` or `codemode` there for interactive Pi. Tools set to `hidden` stay unreachable. Add `codemode` to `tools` only for scripted loops; scripts reach the same named tools.
- `extensions` can stay `false`. Batch tasks inherit `nativeMcp` and `mcpServers`; coordinator members select their own.
- A permitted MCP tool may write or act outside `cwd`, and the secret-path guard does not cover external servers. Grant capabilities deliberately.

Setup for GitHub, Serena and agent-browser: [optional tools](docs/optional-tools.md). Web search: [research](docs/research.md). Details and recovery: [native MCP](docs/reference.md#native-mcp).

## Dura: runs built to finish

**Always on**
- Turn and time budgets. `spawn` and `spawn_batch` default to 30 turns and 10 minutes, `run` to 12 turns and 5 minutes; the ceilings are `PI_DELEGATE_MAX_TURNS` (default 50) and `PI_DELEGATE_MAX_DURATION_MS` (default 15 minutes). `maxToolCalls` optionally caps the delegate's own calls.
- At 75% of the turn budget or tool-call cap (if `maxToolCalls` is set), or after 2/3 of the time, the delegate is told to wrap up; its last turn has no tools and is reserved for the answer.
- `answerState` flags an empty (`missing`) or cut-off (`partial`) answer. A run that ends without an answer (`aborted`, `error`) returns its latest substantial text as `salvagedText`. Finished results name the model that answered.

**Opt-in**
- [Soft deadline](docs/reference.md#long-running-work) (`PI_DELEGATE_DEADLINE_GRACE_MS`): at the deadline the tools go, no new tool call starts, and the delegate has this long to answer; only a run still without an answer is aborted.
- [Model fallback](docs/reference.md#continuing-on-another-model-after-a-provider-error) (`PI_DELEGATE_FALLBACK_MODELS`, or `fallbackModels` per call): after a provider error that outlasts Pi's retries, the run continues in the same session on the next model listed, e.g. `"xai/*:high,antigravity/gemini-*"`. In our use, a Codex quota error now continues on Grok within seconds.
- For models that keep calling tools: `PI_DELEGATE_ANSWER_GRACE=1` gives one more tool-free turn, `PI_DELEGATE_TOOL_CHOICE_NONE` sends `toolChoice: "none"` on that turn, `PI_DELEGATE_FINISH_THINKING` lowers the thinking level once a run is wrapping up.
- [Durable sessions](docs/reference.md#recovery-after-a-server-restart) (`durable: true`): SQLite checkpoints; after a server restart the session resumes with its id, history and budgets, and a tool call whose outcome is unknown is never blindly replayed. Finished ones are kept for 7 days by default (`retentionDays`, `PI_DELEGATE_RETENTION_DAYS`).
- [`handoff`](docs/reference.md#handing-over-between-windows): `save` a note in one Claude/Codex window, `read` it in another to continue the same durable session.

## Safe defaults

- A call that omits `tools` gets the read-only set (`read`, `grep`, `find`, `ls`, or your `PI_DELEGATE_DEFAULT_TOOLS`); anything more must be permitted with `PI_DELEGATE_ALLOW_TOOLS`. This is not a sandbox: a delegate given `bash` can do anything you can.
- Secret paths (`.env`, `~/.ssh`, credentials) are refused for attachments, reads and searches; `PI_DELEGATE_SECRET_GUARD=0` turns this off.
- Sessions live in memory and end with the MCP process. Durable storage, fallback, the soft deadline, the answer grace turn, native MCP and the coordinator are off unless you turn them on.
- By default at most 4 delegates run at once per server process (`PI_DELEGATE_MAX_CONCURRENT`). A model name that does not resolve is refused, never replaced by the default.

## Documentation

- [Reference](docs/reference.md): [tools](docs/reference.md#tools), [configuration](docs/reference.md#configuration), [authentication](docs/reference.md#auth), [native MCP](docs/reference.md#native-mcp)
- [Optional MCP tools](docs/optional-tools.md) · [Web research](docs/research.md) · [Review and synthesize](docs/workflows/review-and-synthesize.md) · [Coordinator](docs/workflows/codemode-coordinator.md)
- [Development](docs/reference.md#development) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/Nyarlathoteppppp/pi-durateam/issues)

---

[MIT](LICENSE) · Built on [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp) and Pi Durable.
