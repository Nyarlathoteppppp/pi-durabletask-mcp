<p align="center">
  <img src="https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durateam/main/docs/assets/hero-teams.zh-CN.svg" alt="pi-durateam — 分工给多个模型，再把结论汇总回来" width="100%" />
</p>

<div align="center">

[English](README.md) · **简体中文**

# pi-durateam

给 Claude Code 和 Codex 配一支 [Pi](https://pi.dev) agent 团队：哪家 provider 的模型都能用，每次运行都要跑完、交出答案。

[![npm](https://img.shields.io/npm/v/pi-durateam)](https://www.npmjs.com/package/pi-durateam)
[![CI](https://github.com/Nyarlathoteppppp/pi-durateam/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durateam/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[快速开始](#快速开始) · [Team](#team-多模型分工协作) · [MCP 工具](#每个委托单独配-mcp-工具) · [Dura](#dura-为跑完而设计) · [详细文档](docs/reference.md)

</div>

> 原名 `pi-durabletask-mcp`，现在请安装 `pi-durateam`。旧命令仍然可用；配置、`PI_DELEGATE_*` 环境变量、已保存的状态和工具名都没有变。

---

主 agent 负责规划、选模型和判断结果。读代码、搜索、交叉核对这些重活交给 Pi 委托去跑，花的是 Gemini、Grok、GPT、DeepSeek 或 Pi 支持的其他 provider 的额度，而不是 Claude Code 或 Codex 的额度；主 agent 收到的只是精简的状态和最终报告，或者只是一个文件路径。拿我们自己发布前的那轮审查来说，四个 agent 在 Gemini、Grok 和一个 GPT 模型上一共读了大约两百万 token 的代码，而 Claude 会话只收到约 7 KB 的报告。

- **team**：一个任务单跑或几个任务并行，同一个问题同时问几个模型；fork 让读过一次的上下文回答多个问题；还有可选的 coordinator；每个委托还能单独授予 MCP 服务器（只读的 GitHub、浏览器）。
- **dura**：每次运行都有轮次、时间和工具调用预算，最后一轮去掉工具，专门留给作答。可选：软时限、provider 出错时换模型继续、服务器重启后能恢复的会话。

举个例子，对你的 agent 说：*“用 Pi 把附件里的 diff 同时交给 Gemini、Grok 和 GPT 审查，不要改文件，只报确定的问题并给出 file:line。”* 它会用 `spawn_batch` 把一个共用的 `prompt` 发给三个模型，用 `wait` 收结果，拿回三份独立报告，附带 token 用量和费用。

## 快速开始

**需要 macOS 或 Linux、Node.js 22.19+ 和 Pi。** CI 在 Node.js 22 和 24 上测试 Pi 1.0.0、1.0.4、1.1.0 和 1.3.0。模型调用使用你自己的 provider 凭据。

**1 · 安装 Pi**（已安装可跳过）并登录一个 provider：

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi  # 然后 /login，或者配置一个 provider
```

**2 · 安装 pi-durateam：**

```bash
npm install -g pi-durateam@latest
```

<details>
<summary>或者从源码安装</summary>

```bash
git clone https://github.com/Nyarlathoteppppp/pi-durateam.git
cd pi-durateam && npm ci && npm run build
# 下面用 `node /absolute/path/pi-durateam/dist/index.js` 代替 `pi-durateam`
```

</details>

**3 · 连接。** Claude Code：

```bash
claude mcp add --scope user pi -- pi-durateam
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.pi]
command = "pi-durateam"
```

Codex 桌面版启动 MCP 服务器时的 `PATH` 很精简（不含 Homebrew 和 nvm 的目录），可能既找不到 `pi-durateam`，也找不到它依赖的 `node`。这时服务器根本没启动，会话里只是没有 Pi 工具。这种情况改用绝对路径：

```toml
[mcp_servers.pi]
command = "/opt/homebrew/bin/node" # `which node` 的输出
args = ["/opt/homebrew/lib/node_modules/pi-durateam/dist/index.js"] # 位于 `npm root -g` 下
[mcp_servers.pi.env]
PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" # 服务器启动的程序会继承它
```

更新 pi-durateam 或 Pi 之后要重连 MCP 服务器。[其他客户端 →](docs/reference.md#other-mcp-clients)

**4 · 试一下：** “用 Pi 检查认证模块有没有漏掉权限检查，只读。” `init` 会显示可用模型、provider 凭据和当前设置，`models` 列出委托能用哪些模型。

<details>
<summary>可选：安装 Agent Skill</summary>

这个 [skill](skills/pi-durateam/SKILL.md) 教你的 agent 怎么用这套工作流。把 `SKILL.md` 放进客户端的 skills 目录：

```bash
dir="$HOME/.claude/skills/pi-durateam" # Claude Code
# dir="$HOME/.agents/skills/pi-durateam" # Codex 改用这一行
mkdir -p "$dir"
curl -fsSL https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durateam/main/skills/pi-durateam/SKILL.md \
  -o "$dir/SKILL.md"
```

</details>

## Team 多模型分工协作

- **委托。** `spawn` 在后台启动一个任务，立即返回 `sessionId`。`spawn_batch` 默认一次最多启动 4 个（`PI_DELEGATE_BATCH_MAX`），启动前先检查所有任务，有一个不合法就一个都不启动。`run` 是阻塞调用，适合快速提问。用 `wait` 加 `until: "settled"` 收结果。
- **同一个问题问几个模型。** 批次级的 `prompt` 会发给每个任务；每个任务只要写明 `model`，自己的 `prompt` 会接在后面。不同模型家族的盲区不一样，但意见一致不等于正确：动手前先[验证结论](docs/workflows/review-and-synthesize.md)。
- **读一次，问多次。** `forkFrom` 从一个已结束会话的记录出发启动新任务，它读过的文件也在里面；每个 fork 的预算重新计算。
- **中途调整与追问。** 运行中用 `steer` 改方向，用 `answer` 回答它的提问；结束后用 `follow_up` 接着问（它还记得读过的内容）；需要时 `abort`。`status` 给出 `idleMs` 和 `phase`，能分清是在慢慢思考还是请求挂住了。
- **材料进，报告出。** `attachments` 用绝对路径传入 diff 或笔记；`saveTo` / `saveDir` 把长报告写进文件，只返回路径；`usage` 给出 token 用量和费用。
- **Coordinator（可选）。** 给 `spawn` 传一个 `coordinator` 计划，由一个 Pi coordinator 按计划派发成员，必要时针对某个成员追问，最后写一份汇总并引用原始报告。需要在 `PI_DELEGATE_ALLOW_TOOLS` 里放开 `codemode`。大多数情况下，`spawn_batch` 加上你自己的判断更简单。[工作流 →](docs/workflows/codemode-coordinator.md)

## 每个委托单独配 MCP 工具

委托可以使用 Pi 的 `mcp.json` 里配置的 MCP 服务器（只读的 GitHub、Serena、浏览器、联网搜索），按任务选择，默认一个都不开。先把服务器加进 `~/.pi/agent/mcp.json`，再在 pi-durateam 的环境变量里放开具体的工具名（`PI_DELEGATE_ALLOW_TOOLS="mcp__github__get_file_contents,mcp__github__search_code"`），然后重连。之后在每次调用里选择：

```json
{
  "cwd": "/absolute/repo",
  "nativeMcp": true,
  "mcpServers": ["github"],
  "tools": ["mcp__github__get_file_contents"],
  "prompt": "Read package.json of OWNER/REPO with GitHub MCP and report its version."
}
```

- 只有 `mcpServers` 里列出的服务器会被连接。这些服务器的工具里，委托只能拿到 `tools` 里写明、并且 `PI_DELEGATE_ALLOW_TOOLS` 放开了的 `mcp__<server>__<tool>`；选中一个服务器不等于拿到它的全部工具。
- 选了服务器、却没授予其中任何一个工具的调用，会在启动前直接被拒绝。比如省略了 `tools`（于是用只读默认值），或者只给了 `codemode`、`tool_search`：它们只能调用 `tools` 里写明的工具。`tools: []` 仍然是不带工具的运行。
- 工具名怎么写取决于该服务器在 `mcp.json` 里的 `exposure`：`direct` 只写 `mcp__<server>__<tool>` 就够了（上面的例子就是这样），`codemode` 还要加上 `codemode`，`deferred` 还要加上 `tool_search`。
- `extensions` 可以保持 `false`。批次里的任务会继承 `nativeMcp` 和 `mcpServers`；coordinator 成员各自选择，而且它们用的服务器必须设成 `direct` 暴露方式。
- 放开的 MCP 工具可能会写文件，或者在 `cwd` 之外操作，敏感路径保护也管不到外部服务器。授予哪些能力要想清楚。

GitHub、Serena 和 agent-browser 的配置见[可选工具](docs/optional-tools.md)，联网搜索见[联网调研](docs/research.md)，暴露方式和崩溃恢复见[原生 MCP](docs/reference.md#native-mcp)。

## Dura 为跑完而设计

**始终生效**
- 轮次、时间和工具调用三重预算。`spawn` 和 `spawn_batch` 默认 30 轮、10 分钟，`run` 默认 12 轮、5 分钟；上限由 `PI_DELEGATE_MAX_TURNS`（默认 50）和 `PI_DELEGATE_MAX_DURATION_MS`（默认 15 分钟）决定。`maxToolCalls` 限制委托自己发起的工具调用次数。
- 轮次或工具调用用到 75%，或者时间用掉 2/3 时，会提醒委托收尾；最后一轮去掉工具，专门留给作答。
- `answerState` 标出空答案（`missing`）或被截断的答案（`partial`）。没给出答案就结束的运行（`aborted`、`error`）会把中途写过的最近一段较长文字作为 `salvagedText` 返回。结束的结果会写明实际作答的模型。

**可选**
- [软时限](docs/reference.md#long-running-work)（`PI_DELEGATE_DEADLINE_GRACE_MS`）：到点先去掉工具、不再启动新的工具调用，给委托这么长的时间作答；宽限期过了还没答的才中止。
- [备用模型](docs/reference.md#continuing-on-another-model-after-a-provider-error)（`PI_DELEGATE_FALLBACK_MODELS`，或者每次调用传 `fallbackModels`）：Pi 自动重试后仍然是 provider 错误时，在同一个会话里换成列表中的下一个模型继续，例如 `"xai/*:high,antigravity/gemini-*"`。我们自己用下来，Codex 额度用完会在几秒内切到 Grok 继续。
- 针对总想调用工具、停不下来的模型：`PI_DELEGATE_ANSWER_GRACE=1` 多给一轮不带工具的作答机会，`PI_DELEGATE_TOOL_CHOICE_NONE` 在那一轮同时发送 `toolChoice: "none"`，`PI_DELEGATE_FINISH_THINKING` 在收尾阶段降低思考等级。
- [Durable 会话](docs/reference.md#recovery-after-a-server-restart)（`durable: true`）：SQLite 检查点；服务器重启后，会话带着原来的 id、历史和预算继续，结果未知的工具调用不会被盲目重放。结束后默认保留 7 天（`retentionDays`、`PI_DELEGATE_RETENTION_DAYS`）。
- [`handoff`](docs/reference.md#handing-over-between-windows)：在一个 Claude/Codex 窗口里 `save` 交接笔记，到另一个窗口 `read`，接着用同一个 durable 会话。

## 默认是安全的

- 调用里省略 `tools` 时只给只读工具（`read`、`grep`、`find`、`ls`，或者你设置的 `PI_DELEGATE_DEFAULT_TOOLS`）；更多工具必须先用 `PI_DELEGATE_ALLOW_TOOLS` 放开。这不是沙箱：拿到 `bash` 的委托能做你能做的任何事。
- 敏感路径（`.env`、`~/.ssh`、各类凭据）在附件、读取和搜索里都会被拒绝；设 `PI_DELEGATE_SECRET_GUARD=0` 可以关掉。
- 会话默认只在内存里，MCP 进程退出就结束。Durable 存储、备用模型、软时限、作答宽限、原生 MCP 和 coordinator 都默认关闭，要自己打开。
- 每个服务器进程默认最多同时运行 4 个委托（`PI_DELEGATE_MAX_CONCURRENT`）。解析不了的模型名会直接报错，不会悄悄换成默认模型。

## 文档

- [详细文档](docs/reference.md)：[工具](docs/reference.md#tools)、[配置](docs/reference.md#configuration)、[认证](docs/reference.md#auth)、[原生 MCP](docs/reference.md#native-mcp)
- [可选 MCP 工具](docs/optional-tools.md) · [联网调研](docs/research.md) · [并行审查与汇总](docs/workflows/review-and-synthesize.md) · [Coordinator](docs/workflows/codemode-coordinator.md)
- [开发](docs/reference.md#development) · [更新日志](CHANGELOG.md) · [Issues](https://github.com/Nyarlathoteppppp/pi-durateam/issues)

---

[MIT](LICENSE) · 基于 [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp) 和 Pi Durable。
