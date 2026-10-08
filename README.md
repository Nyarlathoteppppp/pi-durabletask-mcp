<p align="center">
  <img src="https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/docs/assets/hero-teams.svg" alt="pi-durabletask-mcp — Split work across models. Bring findings together." width="100%" />
</p>

<div align="center">

**English** · [简体中文](README.zh-CN.md)

# pi-durabletask-mcp

Let your main Claude Code / Codex agent plan the work, with [Pi](https://pi.dev) coordinating agents across providers and collecting results.

[![npm](https://img.shields.io/npm/v/pi-durabletask-mcp)](https://www.npmjs.com/package/pi-durabletask-mcp)
[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[Quick start](#quick-start) · [Team example](docs/workflows/codemode-coordinator.md) · [Reference](docs/reference.md)

</div>

---

| **01 · Orchestrate by Task** | **02 · Fork Shared Context** | **03 · Question Then Synthesize** |
| :--- | :--- | :--- |
| Your main agent plans; Pi dispatches work to models selected for each role. | Fork a settled session’s facts and context into independent branches to explore different directions. | Ask targeted follow-ups on disagreements; collect evidence and gaps with references to original reports. |
| [Codemode teams →](docs/workflows/codemode-coordinator.md) | `forkFrom` · independent branches, fresh budgets | `follow_up` · summaries and full reports |

## Example workflow

> Have a team review authentication changes without edits, question disagreements, and summarize missing tests.

**Supply a goal and assignments → Pi dispatches in parallel → question disagreements → collect the synthesis and original reports.**

Choose a provider/model per role: one checks permissions, one researches sources with Exa, and one proposes tests. Your main agent keeps the final judgment. [See the full task plan and configuration →](docs/workflows/codemode-coordinator.md)

**A plan is enough.** With `codemode` permitted, `spawn` can dispatch, collect and synthesize:

```json
{
  "cwd": "/absolute/repo",
  "coordinator": {
    "tasks": [
      { "label": "permissions", "prompt": "Review authentication permission checks; cite evidence." },
      { "label": "tests", "prompt": "Check authentication tests for concrete coverage gaps." }
    ]
  }
}
```

Add models, `forkFrom` and `saveDir` as needed. Supply `prompt` for your own strategy;
use `spawn_batch` for parallel reports without synthesis.

## What you can do

| | Highlights |
| :--- | :--- |
| **Delegate & Explore** | **Parallel models:** select with `models`, dispatch with `spawn_batch`. **Shared context:** `forkFrom` a settled session. **Web research:** opt-in [Exa search and fetch](docs/research.md). **Native MCP:** selected [optional integrations](docs/optional-tools.md); Pi extensions configured separately. |
| **Refine & Report** | **Adjust the direction:** `steer` live work, `follow_up` finished work, and renew budgets as needed. **Pass materials, keep results:** `attachments` and `saveTo`, with summaries, original report references, an opt-in [team index](docs/workflows/codemode-coordinator.md#saved-team-index), token usage and cost. |
| **Permissions & Recovery** | **Authorized implementation:** ordinary delegates can edit or run commands and report successful changed-file paths. **Visible progress:** `idleMs`, `phase` and execution budgets. **Optional single-session recovery:** SQLite checkpoints and cross-window `handoff`. |

Teams support Codemode loops, conditions and parallel calls, with [per-member GitHub, Serena, browser and Exa tools](docs/workflows/codemode-coordinator.md#member-mcp-tools). They use one level of memory-only children for read-only tasks; permit `codemode` on the server (selected automatically when team tools are omitted). For a single task, use an ordinary delegate.

---

## Quick start

**Requires macOS or Linux, Node.js 22.19+ and Pi (managed or npm-global).** CI covers Pi **1.0.0, 1.0.4 and 1.1.0**; Windows is not supported. Model calls use your own provider credentials and quota.

### 1 · Install

The team workflow above is in **GitHub v0.7.11**; use the source-install option below. The current npm release is **0.7.8**.

Already configured Pi? Install the bridge:

```bash
npm install -g pi-durabletask-mcp
```

<details>
<summary>Install and configure Pi first</summary>

The bridge uses your installed Pi SDK. Managed-install support is currently source-only; use the source option below until the next npm release. Install Pi first:

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi  # configure a provider or use /login
```

Search uses Pi's downloaded `rg` or ripgrep on PATH. [Authentication →](docs/reference.md#auth)

</details>

<details>
<summary>Install from source</summary>

Pi must already be installed. Reconnect the MCP after each Pi update; new bridge processes follow the current SDK.

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

The agent uses `spawn` → `wait(until: "settled")`, answering questions with `answer`. `init` is optional diagnostics; `models` lists available models.

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
