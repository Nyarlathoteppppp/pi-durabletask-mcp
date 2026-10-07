# Optional tools for ordinary Pi delegates

These integrations are local choices, not bridge dependencies or default delegate tools.
Install the upstream server you need, add it to Pi's `mcp.json`, and grant its **exact**
`mcp__<server>__<tool>` names in your MCP host's `PI_DELEGATE_ALLOW_TOOLS`.
Then reconnect that host. Merely installing a tool does not expose it to delegates.

| Integration | Useful for | Trial configuration |
| --- | --- | --- |
| [GitHub MCP](https://github.com/github/github-mcp-server) | Repository files, code search, PRs/issues and CI diagnostics | Read-only server, selected tools |
| [Serena](https://github.com/oraios/serena) | Symbol definitions and callers in larger codebases | Five symbol/project tools; no editing or shell |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | Browser-based checks when search/fetch is insufficient | Core profile, independent browser session per delegate |

Verified locally with GitHub MCP **2.0.0**, Serena **1.7.0**, agent-browser **0.38.2**.
Tool names and authentication belong to those upstream projects: list the installed
server's tools before granting them. No promise of provider token savings or better review accuracy.

## Select one server for a task

For a configured server named `github`:

```json
{
  "cwd": "/absolute/repo",
  "nativeMcp": true,
  "mcpServers": ["github"],
  "tools": ["mcp__github__get_file_contents"],
  "prompt": "Read package.json of OWNER/REPO with GitHub MCP and report its version."
}
```

Use `spawn`, collect with `wait`, and inspect actual successful tool calls. Other
configured servers are not connected by this request. `codemode` is optional for
loops or parallel calls; it does not grant unlisted tools.

## GitHub: keep the server read-only

Install the official binary for your platform. Start it with:

```bash
github-mcp-server stdio --read-only --tools get_file_contents,search_code,search_repositories,issue_read,pull_request_read,actions_list,actions_get,get_job_logs
```

It needs `GITHUB_PERSONAL_ACCESS_TOKEN`. A local launch wrapper can obtain an existing
credential with `gh auth token` at startup; keep credentials out of committed JSON
and logs. Grant only the corresponding `mcp__github__...` names. The server's
`--read-only` also removes write operations from discovery.

## Serena: symbols without editing

Install using the upstream quick start. Launch with the supplied
[read-only context](examples/serena-readonly.yml):

```bash
serena start-mcp-server --context /absolute/serena-readonly.yml --project-from-cwd \
  --enable-web-dashboard false --enable-gui-log-window false --open-web-dashboard false
```

Grant `get_symbols_overview`, `find_symbol`, `find_referencing_symbols`,
`activate_project` and `initial_instructions` under `mcp__serena__`.
Pi starts the server in the delegate's cwd. Serena may create `.serena/` project
configuration and language-server caches; keep machine-specific files out of commits.
No editing, shell or REPL tool is exposed by this context. Tool permissions are not
an OS sandbox; ordinary Pi secret-file guards do not wrap external MCP servers.

## Browser: independent sessions

Install `agent-browser` separately and use its version-matched help. The optional
[browser launcher](examples/browser-mcp.sh) assigns a fresh `AGENT_BROWSER_SESSION`
to each MCP subprocess and closes that session when its launcher exits normally.
Use the upstream browser installation instructions if no supported browser exists.

Start with exact tools for open/snapshot/click/fill/scroll/text/url/close. Browser
interaction can submit or change external data; task authorization still applies.
It uses an isolated browser session, not the user's logged-in browser. Ask the delegate
to snapshot after navigation, verify the observed change, then close its session.
A killed launcher may require manual browser cleanup.

## Team boundary

These optional servers work with ordinary `spawn` / `run` / `spawn_batch` delegates.
Coordinator children currently allow only read-only built-ins plus optional Exa;
these integrations are **not** implicitly inherited by a team. Keep original reports
and the optional [team report index](workflows/codemode-coordinator.md#saved-team-index)
for reviewing outcomes across windows.
