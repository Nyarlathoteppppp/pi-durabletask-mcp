<p align="center">
  <img src="https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/docs/assets/hero.png" alt="pi-durabletask-mcp — Delegate. Steer. Recover." width="900" />
</p>

<div align="center">

**English** · [简体中文](README.zh-CN.md)

# pi-durabletask-mcp

Multi-model agent teams for Claude Code, Codex, and other MCP clients, powered by [Pi Coding Agent](https://pi.dev). Delegate work, compare ideas and collect results across providers—in one agent or a coordinated team.

[![npm](https://img.shields.io/npm/v/pi-durabletask-mcp)](https://www.npmjs.com/package/pi-durabletask-mcp)
[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[Quick start](#quick-start) · [Reference](docs/reference.md)

</div>

## Example workflow

```text
You → Claude / Codex / another MCP main model:
  “Use a Pi team to review this authentication change. Assign one agent to
   permission checks, one to Exa source research, and one to brainstorm tests.
   Choose available provider/model IDs per task. Don't edit files.
   Ask targeted follow-ups about conflicting claims; summarize evidence,
   disagreements and gaps, keeping full reports available by reference.”
Main model → Pi coordinator/synthesizer (caller supplies the task assignments)
               ├─ provider/model selected for code review
               ├─ provider/model selected for web research (opt-in Exa)
               └─ provider/model selected for test brainstorming
             → targeted follow-ups → synthesis + original report references
```

For a single task, use an ordinary delegate instead; explicitly authorized tools can also edit files and execute commands.

## What you can do

- **Teams across providers:** select a model for each role with `models`; use a single delegate or run several with `spawn_batch`.
- **[A coordinator that does the legwork](docs/workflows/codemode-coordinator.md):** supply a task plan; Pi dispatches agents, collects reports, asks targeted questions and synthesizes findings with their sources and disagreements. Codemode supports loops, conditions and parallel calls.
- **Read once, explore many directions:** `forkFrom` gives independent branches the same settled context, with fresh budgets for each branch.
- **Discuss and refine:** redirect live work with `steer`, or keep the conversation going with `follow_up` and optional fresh budgets.
- **Reports without manual copying:** pass files through `attachments`, save results with `saveTo`, and receive a summary alongside references to the originals.
- **Authorized implementation:** grant ordinary delegates editing or command tools; results report successful changed-file paths, token usage and cost.
- **[Web research](docs/research.md) and native MCP:** connect selected servers and tool permissions, including opt-in Exa search/fetch. Third-party Pi extensions are configured separately.
- **Progress and recovery:** inspect `idleMs` and `phase`; bound runs with turn, tool and time budgets. Optional `durable: true` checkpoints individual sessions to SQLite, and `handoff` helps another window continue.

Coordinator teams currently use one level of memory-only, read-only children, with optional Exa research. Team mode requires permitted `codemode` and `tools: ["codemode"]`; [the example](docs/workflows/codemode-coordinator.md) shows the task plan and configuration.

## Quick start

**Requires macOS or Linux, Node.js 22.19+ and global Pi.** CI-tested with Pi **1.0.0 and 1.0.4**; Windows is not supported. Model calls use your own provider credentials and quota.

### 1 · Install

The team workflow above is on **GitHub main**; use the source-install option below. The current npm release is **0.7.8**.

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
