<p align="center">
  <img src="https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/docs/assets/hero-teams.svg" alt="pi-durabletask-mcp — Split work across models. Bring findings together." width="100%" />
</p>

<div align="center">

**English** · [简体中文](README.zh-CN.md)

# pi-durabletask-mcp

From Claude Code or Codex, hand reviews and investigations to [Pi](https://pi.dev) agents running on any provider — Gemini, Grok, GPT, DeepSeek and more — in the background, and get back their reports.

[![npm](https://img.shields.io/npm/v/pi-durabletask-mcp)](https://www.npmjs.com/package/pi-durabletask-mcp)
[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[Quick start](#quick-start) · [What you can do](#what-you-can-do) · [Reference](docs/reference.md)

</div>

---

## Why

- **Spend far less of your Claude Code / Codex quota on the same work.** The heavy part of a review or investigation — reading code, searching, cross-checking — runs on other providers. Your main agent only plans, waits and judges, and receives compact status and the final report, or just a file path.
- **Put your other subscriptions to work.** Free tiers and plans you already pay for (Gemini, Grok, GPT, DeepSeek…) usually sit half unused. Pi runs on all of them, so that capacity does real work instead of expiring.
- **Other model families, other blind spots.** Reviewers from one family tend to miss the same things. Send one diff to Gemini, Grok and GPT at once and compare.
- **Built to finish.** Every run has turn, time and tool-call budgets with a tool-free last turn for the answer; opt-in model fallback on provider errors; opt-in durable tasks that survive a restart.

Your main agent stays in charge: it plans, chooses models and judges the results.

## In 30 seconds

Ask your agent:

> Use Pi to review the attached diff with Gemini, Grok and GPT in parallel. Don't edit files. Report only real defects with file:line.

It calls `spawn_batch` with one prompt and three models, waits with `wait`, and returns three independent reports with token usage and cost. One provider down? With fallback configured, that review continues on another model in the same session.

## Quick start

**Requires macOS or Linux, Node.js 22.19+ and Pi.** CI covers Pi 1.0.0, 1.0.4, 1.1.0 and 1.3.0. Model calls use your own provider credentials.

**1 · Install Pi** (skip if you have it) and configure a provider:

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi  # then /login or configure a provider
```

**2 · Install the bridge:**

```bash
npm install -g pi-durabletask-mcp@latest
```

<details>
<summary>Or install from source</summary>

```bash
git clone https://github.com/Nyarlathoteppppp/pi-durabletask-mcp.git
cd pi-durabletask-mcp && npm ci && npm run build
```

Connect with `node /absolute/path/pi-durabletask-mcp/dist/index.js` instead of `pi-durabletask-mcp` below.

</details>

**3 · Connect.** Claude Code:

```bash
claude mcp add --scope user pi -- pi-durabletask-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.pi]
command = "pi-durabletask-mcp"
```

The Codex desktop app starts MCP servers with a minimal `PATH` (no Homebrew or nvm directories), so it may find neither `pi-durabletask-mcp` nor the `node` it runs on. The server then never starts, and the session simply has no Pi tools. Use absolute paths there:

```toml
[mcp_servers.pi]
command = "/opt/homebrew/bin/node" # output of `which node`
args = ["/opt/homebrew/lib/node_modules/pi-durabletask-mcp/dist/index.js"] # under `npm root -g`

[mcp_servers.pi.env]
PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" # inherited by what the server starts
```

Reconnect the MCP after updating the bridge or Pi. [Other clients →](docs/reference.md#other-mcp-clients)

**4 · Try it:** "Use Pi to check the auth module for missing permission checks. Read only." `init` shows your models and settings; `models` lists what each delegate may use.

<details>
<summary>Optional: install the Agent Skill</summary>

The [skill](skills/pi-durabletask-mcp/SKILL.md) teaches your agent the workflow. Put `SKILL.md` in your client's skills directory:

```bash
dir="$HOME/.claude/skills/pi-durabletask-mcp" # Claude Code
# dir="$HOME/.agents/skills/pi-durabletask-mcp" # Codex: use instead
mkdir -p "$dir"
curl -fsSL https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/skills/pi-durabletask-mcp/SKILL.md \
  -o "$dir/SKILL.md"
```

</details>

## What you can do

**Delegate**
- `spawn` one task, `spawn_batch` up to four at once by default (`PI_DELEGATE_BATCH_MAX`; one shared `prompt` for a multi-model review), `run` for a quick blocking question.
- `forkFrom` a finished session: read the code once, then ask several independent questions from the same context.
- Pass material with `attachments` (a diff, notes); add [instruction files and skills](docs/reference.md#explicit-instructions-and-skills) or [web research and MCP tools](docs/optional-tools.md) per task.

**Steer and follow up**
- `wait` returns on progress, a question or the end (`until: "settled"`, or any/all of a batch); a wait for the result lasts as long as the server allows (`PI_DELEGATE_WAIT_MAX_MS`), so you do not poll. `status` gives a snapshot with `idleMs` and `phase`, so you can tell slow reasoning from a hung request.
- `steer` a running agent, `answer` its questions, `follow_up` a finished one with renewed budgets, `abort` when needed.

**Results**
- Compact results by default; `saveTo` / `saveDir` write long reports to files and return the path.
- `answerState` flags empty or cut-off answers; `usage` reports tokens and cost; finished results name the model that answered, after a fallback too.
- A run that ends without an answer returns the latest substantial text it wrote as `salvagedText`, instead of losing that work.

**Reliability**
- Budgets on turns, time and tool calls, with a wrap-up nudge at 75% (2/3 of the time) and a tool-free last turn. Opt-in for models that keep going: `toolChoice: "none"` on that turn (`PI_DELEGATE_TOOL_CHOICE_NONE`) and a lower thinking level once wrapping up (`PI_DELEGATE_FINISH_THINKING`).
- [Soft deadline](docs/reference.md#long-running-work) (opt-in, `PI_DELEGATE_DEADLINE_GRACE_MS`): at the deadline the tools go, no new tool call starts and the delegate gets a grace period to answer; only a run still without an answer after it is aborted.
- [Model fallback](docs/reference.md#continuing-on-another-model-after-a-provider-error) (opt-in): after a provider error that outlasts Pi's retries — gateway timeout, spent quota — the run continues on the next model you list, e.g. `PI_DELEGATE_FALLBACK_MODELS="xai/*:high,antigravity/gemini-*"`.
- [Durable tasks](docs/reference.md#recovery-after-a-server-restart) (opt-in, `durable: true`): SQLite checkpoints, recovery after a restart, interrupted side effects never blindly replayed, finished stores compacted; `handoff` notes for another window.

**Teams (advanced)**
- An opt-in [coordinator](docs/workflows/codemode-coordinator.md) that dispatches your planned read-only members, asks follow-ups on disagreements and writes one synthesis with links to the original reports. For most work, `spawn_batch` and your own judgment are simpler.

## What we get from it

We build this project with it: reviews, design discussions and research for this repo run through these tools every day.

**Highlights**

- **Our Claude quota goes to judgment, not reading.** In the pre-release review, four agents read about two million tokens of this codebase on Gemini, Grok and a GPT model. Our Claude session received about 7 KB of reports and spent its turns deciding what to fix.
- **Subscriptions we were already paying for do the heavy lifting.** Most runs go to Gemini and Grok plans we had anyway. The four Gemini runs of that review round (one review, three verifications) came to about $0.10 at API prices, and to nothing extra on the plan.
- **Several model families find more, and verification keeps it honest.** Parallel reviews from different families surface different issues; an independent verifier then refutes what does not hold. In that pre-release round, verifiers rejected one reviewer's top "major" and confirmed two real recovery bugs, which we fixed the same day.
- **Runs finish when a provider does not.** Gateway timeouts and spent quotas used to cost us a manual rescue each. With fallback configured, a Codex quota error now continues on Grok within seconds, in the same session.
- **Read once, ask many.** A session forked from one that had already read the code answered in a single turn.

**Lessons**

- Agreement is not proof: two of four reviewers once reported the same false positive. Verify findings before acting ([how](docs/workflows/review-and-synthesize.md)).
- Across providers the prompt cache does not carry over, so a large fork can cost more than you expect.
- Some models call a tool even after their tools are gone; the opt-in grace turn keeps that from ending a run with no answer.
- Fast models are cheap but take more turns; strong reasoners can think past their deadline. Leave time and keep thinking levels moderate for long reviews.
- A deadline guards against a hung provider; it is not a work budget. Turn and tool-call budgets bound the work, and tight deadlines cost us finished reviews, so we run with `PI_DELEGATE_MAX_DURATION_MS=3600000`, `PI_DELEGATE_SPAWN_DURATION_MS=1800000` and `PI_DELEGATE_DEADLINE_GRACE_MS=180000` (the defaults are 15 and 10 minutes, with no grace).
- A task's `label` is never sent to the delegate; put what differs between tasks in their `prompt`.

## Safe defaults

- Read-only tools (`read`, `grep`, `find`, `ls`) unless the server permits more with `PI_DELEGATE_ALLOW_TOOLS`. This is not a sandbox: a delegate given `bash` can do anything you can.
- Secret paths (`.env`, `~/.ssh`, credentials) are refused for attachments, reads and searches.
- Memory sessions by default; they end with the MCP process. Durable storage, fallback, the answer grace turn and the soft deadline are off unless you turn them on.
- At most four delegates at once per server process (`PI_DELEGATE_MAX_CONCURRENT`).

## Documentation

- [Reference](docs/reference.md): [tools](docs/reference.md#tools), [configuration](docs/reference.md#configuration), [authentication](docs/reference.md#auth), [native MCP](docs/reference.md#native-mcp)
- [Review and synthesize](docs/workflows/review-and-synthesize.md), including falsifying findings before you act on them
- [Recovery, ownership and retention](docs/reference.md#recovery-after-a-server-restart) · [Handoff](docs/reference.md#handing-over-between-windows)
- [Development](docs/reference.md#development) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/issues)

---

[MIT](LICENSE) · Built on [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp) and Pi Durable.
