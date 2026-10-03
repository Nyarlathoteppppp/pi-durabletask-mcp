<div align="center">

# pi-durabletask-mcp

**Delegate to Pi. Steer as it works. Recover after a restart.**

Run [Pi Coding Agent](https://pi.dev) tasks from Claude Code, Codex, or any MCP client.

[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-339933?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Quick start](#quick-start) · [Usage](#usage) · [Reference](docs/reference.md) · [Changelog](CHANGELOG.md)

</div>

---

## What you get

| Capability | What it does |
| --- | --- |
| **Background delegation** | Inspect progress, steer running tasks, and follow up with shared context. |
| **Opt-in recovery** | Save history, tool results, and pending instructions in SQLite with `durable: true`. |
| **Native MCP** | Select the Pi MCP servers and tools each delegate can use. |
| **Shared Pi SDK** | Use your global Pi installation and configured providers. |

## Quick start

Requires **Node.js 22.19+** and **Pi 1.0.0**. For search, use Pi's downloaded `rg`
or install ripgrep: `brew install ripgrep` (macOS) / `sudo apt-get install ripgrep` (Ubuntu).

```bash
npm install -g @earendil-works/pi-coding-agent@1.0.0
pi  # configure a provider or use /login

git clone https://github.com/Nyarlathoteppppp/pi-durabletask-mcp.git
cd pi-durabletask-mcp
npm ci
npm run build
```

Then connect your client. Replace `/absolute/path/pi-durabletask-mcp` with your checkout path.

### Claude Code

```bash
claude mcp add --scope user pi -- node /absolute/path/pi-durabletask-mcp/dist/index.js
```

Already have a `pi` entry? Update it and reconnect through `/mcp`.

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.pi]
command = "node"
args = ["/absolute/path/pi-durabletask-mcp/dist/index.js"]
```

[Other MCP clients](docs/reference.md#other-mcp-clients).

## Usage

> Use Pi to review this repository and report the findings.

Your agent calls `init` → `spawn` → `wait` / `status`.
Tasks use Pi's configured model and **read-only tools** by default.

For work that should survive a bridge restart, ask for a **durable task** or pass this to `spawn`:

```json
{
  "cwd": "/absolute/path/to/repo",
  "prompt": "Review this repository and report the findings.",
  "durable": true
}
```

<details>
<summary><strong>Available tools</strong></summary>

| Action | Tools |
| --- | --- |
| Start a task | `spawn`, `spawn_batch`, `run` |
| Check progress | `status`, `wait`, `sessions` |
| Redirect or continue | `steer`, `follow_up` |
| Answer, stop, or remove | `answer`, `abort`, `forget` |
| Discover configuration | `init`, `models` |

</details>

[Models & permissions](docs/reference.md#configuration) · [Native MCP setup](docs/reference.md#native-mcp)

## Recovery and updates

- **Default:** tasks stay in memory for the lifetime of the bridge process.
- **With `durable: true`:** unfinished tasks recover on restart; finished history remains available until retention removes it.
- **Unknown tool outcomes:** inspect external state before retrying. The bridge does not blindly replay interrupted operations. Original deadlines include downtime.

After `pi update --all`, run `npm test` here, then reconnect the MCP server.
Pi Durable stays pinned separately. [Recovery details](docs/reference.md#recovery-after-a-server-restart).

---

[Reference](docs/reference.md) · [Development](docs/reference.md#development) · [Issues](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/issues)

[MIT](LICENSE) · Built on [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp) and Pi Durable.
