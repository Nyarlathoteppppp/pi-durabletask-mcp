# pi-durabletask-mcp

Run [Pi Coding Agent](https://pi.dev) tasks from Claude Code, Codex, or any MCP client.
Tasks run in the background and recover from saved checkpoints after a server restart.

- **Delegate:** inspect progress, steer running tasks, and send follow-ups with shared context.
- **Recover:** persist conversation history, tool results, and pending instructions in SQLite.
- **Connect:** use [Pi native MCP tools](docs/reference.md#native-mcp) with explicit server and tool selection.
- **Update:** use the SDK from your global Pi installation.

## Install

Requires **Node.js 22.19+** and **ripgrep** (`rg` on `PATH`).
Install ripgrep with `brew install ripgrep` (macOS) or `sudo apt-get install ripgrep` (Ubuntu).

```bash
npm install -g @earendil-works/pi-coding-agent@1.0.0
pi  # configure a provider or use /login

git clone https://github.com/Nyarlathoteppppp/pi-durabletask-mcp.git
cd pi-durabletask-mcp
npm ci
npm run build
```

Replace `/absolute/path/pi-durabletask-mcp` below with your checkout path.

### Claude Code

```bash
claude mcp add --scope user pi -- node /absolute/path/pi-durabletask-mcp/dist/index.js
```

Already have a `pi` entry? Update it and reconnect through `/mcp`.

### Codex

Add to your MCP configuration:

```toml
[mcp_servers.pi]
command = "node"
args = ["/absolute/path/pi-durabletask-mcp/dist/index.js"]
```

[Other MCP clients](docs/reference.md#other-mcp-clients).

## Use

Ask your agent: **“Use Pi to review this repository and report the findings.”**
It calls `init`, then `spawn`, and checks progress with `wait` or `status`.

| Action | Tools |
| --- | --- |
| Start a task | `spawn`, `spawn_batch`, `run` |
| Check progress | `status`, `wait`, `sessions` |
| Redirect or continue | `steer`, `follow_up` |
| Answer, stop, or remove | `answer`, `abort`, `forget` |
| Discover configuration | `init`, `models` |

Tasks use Pi's configured model and read-only tools by default.
[Configure models and permissions](docs/reference.md#configuration).

## Recovery and updates

Abandoned tasks resume automatically on restart. Completed history and follow-ups remain available.
Original deadlines still apply, including downtime. Interrupted external effects are **not guaranteed
exactly once**; unknown outcomes require inspection before retrying.

After `pi update --all`, run `npm test` here, then reconnect the MCP server.
Pi Durable stays pinned separately. [Recovery details](docs/reference.md#recovery-after-a-server-restart).

## Documentation

[Full reference](docs/reference.md) · [Development](docs/reference.md#development) · [Changelog](CHANGELOG.md)

MIT. Based on [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp).
