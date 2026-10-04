<p align="center">
  <img src="docs/assets/hero.png" alt="pi-durabletask-mcp — Delegate. Steer. Recover." width="900" />
</p>

<div align="center">

**English** · [简体中文](README.zh-CN.md)

**Pi agents for Claude Code, Codex, and any MCP client.**

Background tasks · Live steering · Opt-in SQLite recovery · Native Pi MCP

[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[Get started](#quick-start) · [Features](#key-features) · [Reference](docs/reference.md)

</div>

## Give Pi the task.

Your agent delegates to [Pi Coding Agent](https://pi.dev), checks progress, and collects
the result. Pi reads and searches in its own session, so that work stays out of your agent's
context. Steer live work or follow up in the same conversation.

| Delegate | Steer | Recover |
| :--- | :--- | :--- |
| One task or a batch, in the background. | Redirect work in progress. | Resume after a restart with `durable: true`. |

## Quick start

**Requires Node.js 22.19+ and Pi 1.0.0.** Search uses Pi's downloaded `rg` or ripgrep on PATH.

### 1 · Install

```bash
npm install -g @earendil-works/pi-coding-agent@1.0.0
pi  # configure a provider or use /login

git clone https://github.com/Nyarlathoteppppp/pi-durabletask-mcp.git
cd pi-durabletask-mcp
npm ci
npm run build
```

### 2 · Connect

Replace `/absolute/path/pi-durabletask-mcp` with your checkout path.

**Claude Code**

```bash
claude mcp add --scope user pi -- node /absolute/path/pi-durabletask-mcp/dist/index.js
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.pi]
command = "node"
args = ["/absolute/path/pi-durabletask-mcp/dist/index.js"]
```

Already connected? Update the existing entry and reconnect the MCP server.
[Other clients →](docs/reference.md#other-mcp-clients)

### 3 · Delegate

> Use Pi to review this repository and report the findings.

Your agent calls `spawn` → `wait`. Pi uses your configured model and **read-only tools**
by default. `init` is optional diagnostics; `models` lists alternatives.
[Agent instructions →](docs/reference.md#agent-instructions) · [Models & permissions →](docs/reference.md#configuration)

## Usage

For a task that should recover after a bridge restart, ask for a **durable task**, or pass:

```json
{
  "cwd": "/absolute/path/to/repo",
  "prompt": "Review this repository and report the findings.",
  "durable": true
}
```

<details>
<summary><strong>All 14 tools</strong></summary>

| Want to… | Use |
| :--- | :--- |
| Start work | `spawn` · `spawn_batch` · `run` |
| Check progress | `status` · `wait` · `sessions` |
| Redirect or continue | `steer` · `follow_up` |
| Answer, stop, or remove | `answer` · `abort` · `forget` |
| Discover configuration | `init` · `models` |
| Hand over to a new window | `handoff` |

</details>

Delegates can also use selected **Pi native MCP servers** with an explicit tool allowlist.
[Native MCP setup →](docs/reference.md#native-mcp)

## Key features

- **Keep your agent's context small.** Pi does the reading and searching in its own session and your agent gets the result. Polling is cheap as well: `status` and `wait` return the latest five tool calls and a total (`verbose: true` for the full trace), and `wait` returns as soon as Pi asks a question. `wait` can also hold until a delegate finishes, or until any or all of a batch do.
- **Run several delegates at once.** `spawn_batch` starts a batch in one call, each task with its own model if you like, for example a cheaper model for search or a second vendor's model to review the same change.
- **Steer and continue.** `steer` redirects running work. `follow_up` continues a finished conversation with everything Pi already read. Turn and time limits are configurable; the time limit applies to each run, so a durable session can be continued days later, while turns count across the session.
- **Ready for agents on connect.** Tools work right after connecting. `spawn` with a repo path uses your configured model and read-only tools. `init` is there to diagnose models, permissions and provider auth.
- **Bad models and credentials fail early.** An explicit model and Pi's own default pass the same allowlist, denylist and scope checks. A provider whose auth cannot be resolved is refused before the run starts, and `init` lists it under `failingProviders`. Pi's automatic provider retries show up in status notices.
- **Durable when it matters.** Tasks live in memory by default. `durable: true` saves one to SQLite so it survives a bridge restart. Each durable task has exactly one owner, held by a kernel-released lock, and any session can read a finished task's result. History is kept seven days by default, `retentionDays` sets it per task, and expired history is removed automatically; storage pressure can remove finished history earlier.
- **Native Pi MCP.** Choose servers and exact tool permissions per delegate, including `codemode` and `tool_search`. Third-party extensions are a separate opt-in.
- **Your Pi setup.** Reuse your global Pi SDK and provider configuration; choose a model for each delegate.

[Configuration →](docs/reference.md#configuration) · [Ownership & retention →](docs/reference.md#ownership)

## What recovery means

Tasks are **in memory by default**. With `durable: true`, SQLite saves history, tool results,
and pending steering. Unfinished tasks recover on restart; finished history stays until
retention removes it.

Interrupted tools can have **unknown outcomes**. The bridge does not blindly replay their
side effects; inspect external state before retrying. Downtime counts against the current
run's time limit.
[Recovery & retention →](docs/reference.md#recovery-after-a-server-restart)

<details>
<summary><strong>Updating Pi</strong></summary>

After `pi update --all`, run `npm test` in this checkout, then reconnect the MCP server.
The bridge shares your global Pi SDK; Pi Durable stays pinned separately.

</details>

---

<div align="center">

[Reference](docs/reference.md) · [Development](docs/reference.md#development) · [Handoff notes](CLAUDE.md) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/issues)

[MIT](LICENSE) · Built on [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp) and Pi Durable.

</div>
