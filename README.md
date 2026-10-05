<p align="center">
  <img src="https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/docs/assets/hero.png" alt="pi-durabletask-mcp — Delegate. Steer. Recover." width="900" />
</p>

<div align="center">

**English** · [简体中文](README.zh-CN.md)

# pi-durabletask-mcp

Delegate work from Claude Code, Codex, or another MCP client to [Pi Coding Agent](https://pi.dev), in its own context.

[![npm](https://img.shields.io/npm/v/pi-durabletask-mcp)](https://www.npmjs.com/package/pi-durabletask-mcp)
[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[Quick start](#quick-start) · [Reference](docs/reference.md)

</div>

## Example workflow

```text
You: Use Pi to review authentication for missing permission checks. Don't edit files.
     Explicitly set durable: true so we can continue in another window.
  → spawn with the absolute repo cwd and durable: true
While running: Focus on tenant isolation; skip style issues.
  → steer
After the review: Suggest a regression test for the most serious finding.
  → follow_up in the same session
Switching windows: Save findings and next steps → handoff save
New window: Read this repo's handoff → handoff read; follow resumeHint
```

To collect results, the main agent loops `wait` with `until: "settled"`. If Pi asks a question, use `answer` with the question ID, then wait again.

## What you can do

- **Separate context:** Pi reads and searches; your main agent collects findings.
- **Attachments:** pass a diff or notes by file path with `attachments`, instead of pasting them into the prompt.
- **Multiple models:** `spawn_batch` starts tasks with individually selected models.
- **Live steering:** `steer` redirects work after the current tool call.
- **Liveness:** running delegates report `idleMs` and `phase`, so slow reasoning can be told from a hung request; `PI_DELEGATE_STALL_MS` optionally ends a silent request.
- **Follow-ups:** `follow_up` keeps context in the same long-lived session; turns accumulate.
- **Final-turn wrap-up:** tools are disabled on the last turn and the model is asked to provide a final answer; results include token usage and cost.
- **Recovery:** explicit `durable: true` saves checkpoints to SQLite.
- **Handoff:** leave a note for the next Claude/Codex window.
- **Native MCP:** `nativeMcp` explicitly selects servers and tool permissions; third-party extensions are enabled separately.

## Quick start

**Requires Node.js 22.19+ and global Pi.** CI-tested with Pi **1.0.0 and 1.0.2**. Model calls use your own provider credentials and quota.

### 1 · Install

Already configured Pi? Install the bridge:

```bash
npm install -g pi-durabletask-mcp
```

<details>
<summary>Install and configure Pi first</summary>

The bridge links to the global Pi SDK, so install Pi before the bridge:

```bash
npm install -g @earendil-works/pi-coding-agent@1.0.0
pi  # configure a provider or use /login
```

Search uses Pi's downloaded `rg` or ripgrep on PATH. [Authentication →](docs/reference.md#auth)

</details>

<details>
<summary>Install from source</summary>

Global Pi is still required.

```bash
git clone https://github.com/Nyarlathoteppppp/pi-durabletask-mcp.git
cd pi-durabletask-mcp
npm ci
npm run build
```

Connect with `node /absolute/path/pi-durabletask-mcp/dist/index.js` instead of the installed command.

</details>

### 2 · Connect

<details>
<summary>Claude Code</summary>

```bash
claude mcp add --scope user pi -- pi-durabletask-mcp
```

</details>

<details>
<summary>Codex</summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.pi]
command = "pi-durabletask-mcp"
```

</details>

Already connected? Update the existing entry and reconnect. [Other clients →](docs/reference.md#other-mcp-clients)

### 3 · Try a review

> Use Pi to review authentication for missing permission checks. Don't edit files. Report file locations and suggested regression tests.

The agent uses `spawn` → `wait(until: "settled")`, answering questions with `answer`. Try the steering and follow-up prompts above. `init` is optional diagnostics; `models` lists available models.

<details>
<summary>Optional: install the Agent Skill</summary>

Connect the MCP server first; this [skill](skills/pi-durabletask-mcp/SKILL.md) only guides tool use. Choose your client's user-level directory and download just `SKILL.md`:

```bash
dir="$HOME/.claude/skills/pi-durabletask-mcp" # Claude Code
# dir="$HOME/.agents/skills/pi-durabletask-mcp" # Codex: use instead
mkdir -p "$dir"
curl -fsSL https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/skills/pi-durabletask-mcp/SKILL.md \
  -o "$dir/SKILL.md"
```

Start a new client session after installing.

</details>

## Defaults & recovery

Tasks use your configured model, **read-only tools and memory storage by default**; memory sessions disappear when their MCP process exits.
With explicit `durable: true`, recovery happens after a bridge restart: per-run time limits include downtime, and tools with unknown outcomes are not blindly replayed—verify external state before retrying.
`handoff` stores notes written by the main agent; reading them does not take over execution.
Cross-window continuation requires a durable task with its original history and note still retained; a live owner must release the task before another process can continue it.

## Documentation

- [Agent instructions](docs/reference.md#agent-instructions) · [Tools](docs/reference.md#tools) · [Configuration](docs/reference.md#configuration)
- [Handoff](docs/reference.md#handing-over-between-windows) · [Native MCP](docs/reference.md#native-mcp)
- [Recovery, ownership & retention](docs/reference.md#recovery-after-a-server-restart)
- [Development](docs/reference.md#development) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/issues)

---

[MIT](LICENSE) · Built on [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp) and Pi Durable.
