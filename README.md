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

- **Other model families, other blind spots.** Reviewers from one family tend to miss the same things. Send one diff to Gemini, Grok and GPT at once and compare.
- **Use the subscriptions you already pay for.** Delegates run on your own Pi providers, not on your main agent's quota.
- **Your main context stays small.** Delegates read the code on their own budget; you get compact status and the final report, or just a file path.
- **Built to finish.** Every run has turn, time and tool-call budgets with a tool-free last turn for the answer; opt-in model fallback on provider errors; opt-in durable tasks that survive a restart.

Your main agent stays in charge: it plans, chooses models and judges the results.

## In 30 seconds

Ask your agent:

> Use Pi to review the attached diff with Gemini, Grok and GPT in parallel. Don't edit files. Report only real defects with file:line.

It calls `spawn_batch` with one prompt and three models, waits with `wait`, and returns three independent reports with token usage and cost. One provider down? With fallback configured, that review continues on another model in the same session.

## Quick start

**Requires macOS or Linux, Node.js 22.19+ and Pi.** CI covers Pi 1.0.0, 1.0.4 and 1.1.0. Model calls use your own provider credentials.

**1 · Install Pi** (skip if you have it) and configure a provider:

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi  # then /login or configure a provider
```

**2 · Install the bridge.** The npm release (0.7.8) lags behind `main`; for everything below, install from source:

```bash
git clone https://github.com/Nyarlathoteppppp/pi-durabletask-mcp.git
cd pi-durabletask-mcp && npm ci && npm run build
```

<details>
<summary>Or the npm release</summary>

```bash
npm install -g pi-durabletask-mcp
```

Then use `pi-durabletask-mcp` as the command below instead of `node …/dist/index.js`.

</details>

**3 · Connect.** Claude Code:

```bash
claude mcp add --scope user pi -- node /absolute/path/pi-durabletask-mcp/dist/index.js
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.pi]
command = "node"
args = ["/absolute/path/pi-durabletask-mcp/dist/index.js"]
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
- `spawn` one task, `spawn_batch` up to four at once (one shared `prompt` for a multi-model review), `run` for a quick blocking question.
- `forkFrom` a finished session: read the code once, then ask several independent questions from the same context.
- Pass material with `attachments` (a diff, notes); add [instruction files and skills](docs/reference.md#explicit-instructions-and-skills) or [web research and MCP tools](docs/optional-tools.md) per task.

**Steer and follow up**
- `wait` returns on progress, a question or the end (`until: "settled"`, or any/all of a batch); `status` for a snapshot with `idleMs` and `phase`, so you can tell slow reasoning from a hung request.
- `steer` a running agent, `answer` its questions, `follow_up` a finished one with renewed budgets, `abort` when needed.

**Results**
- Compact results by default; `saveTo` / `saveDir` write long reports to files and return the path.
- `answerState` flags empty or cut-off answers; `usage` reports tokens and cost.

**Reliability**
- Budgets on turns, time and tool calls, with a wrap-up nudge at 75% and a tool-free last turn.
- [Model fallback](docs/reference.md#continuing-on-another-model-after-a-provider-error) (opt-in): after a provider error that outlasts Pi's retries — gateway timeout, spent quota — the run continues on the next model you list, e.g. `PI_DELEGATE_FALLBACK_MODELS="xai/*:high,antigravity/gemini-*"`.
- [Durable tasks](docs/reference.md#recovery-after-a-server-restart) (opt-in, `durable: true`): SQLite checkpoints, recovery after a restart, interrupted side effects never blindly replayed; `handoff` notes for another window.

**Teams (advanced)**
- An opt-in [coordinator](docs/workflows/codemode-coordinator.md) that dispatches your planned read-only members, asks follow-ups on disagreements and writes one synthesis with links to the original reports. For most work, `spawn_batch` and your own judgment are simpler.

## What we learned using it

We build this with it: reviews, design discussions and research for this repo run through these tools every day. What stood out:

- **Agreement is not proof.** In one review round, two of four reviewers reported the same false positive. In another, independent verifiers refuted one reviewer's top "major" finding and confirmed two real recovery bugs, which we fixed. We now send every finding we would act on to a fresh agent that tries to refute it ([how](docs/workflows/review-and-synthesize.md)).
- **Providers fail mid-run more often than you would think.** In one day we hit gateway timeouts on large contexts and a spent Codex quota three times, and rescued each run by hand by forking it to another model. With fallback configured, the same quota error later switched the run to Grok within seconds, same session, nothing for us to do.
- **Forking keeps what was read.** A forked session answered in one turn from the code its parent had already read. Across providers the prompt cache does not carry over, so a large fork can cost noticeably more than you expect.
- **Not every model respects a tool-free last turn.** Some still call a tool after their tools are gone, and the run used to end with no answer. That is what the opt-in grace turn is for.
- **Different models, different habits.** A fast model is cheap but uses many turns; a strong reasoning model can think past its deadline on the last turn. Budget time accordingly and keep thinking levels moderate for long reviews.
- **Labels are not prompts.** A task's `label` is never sent to the delegate. Put what differs between tasks in their `prompt`.

## Safe defaults

- Read-only tools (`read`, `grep`, `find`, `ls`) unless the server permits more with `PI_DELEGATE_ALLOW_TOOLS`. This is not a sandbox: a delegate given `bash` can do anything you can.
- Secret paths (`.env`, `~/.ssh`, credentials) are refused for attachments, reads and searches.
- Memory sessions by default; they end with the MCP process. Durable storage, fallback and the answer grace turn are off unless you turn them on.
- At most four delegates at once per server process (`PI_DELEGATE_MAX_CONCURRENT`).

## Documentation

- [Reference](docs/reference.md): [tools](docs/reference.md#tools), [configuration](docs/reference.md#configuration), [authentication](docs/reference.md#auth), [native MCP](docs/reference.md#native-mcp)
- [Review and synthesize](docs/workflows/review-and-synthesize.md), including falsifying findings before you act on them
- [Recovery, ownership and retention](docs/reference.md#recovery-after-a-server-restart) · [Handoff](docs/reference.md#handing-over-between-windows)
- [Development](docs/reference.md#development) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/issues)

---

[MIT](LICENSE) · Built on [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp) and Pi Durable.
