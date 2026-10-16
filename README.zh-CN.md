<p align="center">
  <img src="https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/docs/assets/hero-teams.zh-CN.svg" alt="pi-durabletask-mcp — 分工给多个模型，再把结论汇总回来" width="100%" />
</p>

<div align="center">

[English](README.md) · **简体中文**

# pi-durabletask-mcp

在 Claude Code 或 Codex 里，把审查和调查交给 [Pi](https://pi.dev) agent 在后台运行。它们可以用任何 provider 的模型（Gemini、Grok、GPT、DeepSeek……），跑完把报告交回来。

[![npm](https://img.shields.io/npm/v/pi-durabletask-mcp)](https://www.npmjs.com/package/pi-durabletask-mcp)
[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[快速开始](#快速开始) · [能做什么](#能做什么) · [详细文档](docs/reference.md)

</div>

---

## 为什么用它

- **同样的活，明显少花 Claude Code / Codex 的额度。** 审查和调查里最费 token 的部分（读代码、搜索、交叉核对）交给其他 provider 去跑。主 agent 只负责规划、等待和判断，收到的只是精简的状态和最终报告，或者只是一个文件路径。
- **把闲置的订阅用起来。** 免费额度和已经付费的套餐（Gemini、Grok、GPT、DeepSeek……）平时往往用不满。Pi 能接上所有这些 provider，让这部分额度真正干活，而不是白白过期。
- **换个模型家族，换一组盲区。** 同一家族的审查者往往漏掉同样的问题。把同一份 diff 同时交给 Gemini、Grok 和 GPT，对照着看。
- **为跑完而设计。** 每次运行都有轮次、时间和工具调用预算，最后一轮去掉工具、专门作答；可选：provider 出错时自动换模型继续；可选：durable 任务在重启后恢复。

主 agent 始终负责规划、选模型和判断结果。

## 30 秒示例

对你的 agent 说：

> 用 Pi 把附件里的 diff 同时交给 Gemini、Grok 和 GPT 审查，不要改文件，只报确定的问题并给出 file:line。

它会用 `spawn_batch` 把一个 prompt 发给三个模型，用 `wait` 等结果，交回三份独立报告，附带 token 用量和费用。某个 provider 挂了？配置了备用模型的话，那一份审查会在同一个会话里换个模型继续。

## 快速开始

**需要 macOS 或 Linux、Node.js 22.19+ 和 Pi。** CI 覆盖 Pi 1.0.0、1.0.4、1.1.0 和 1.3.0。模型调用使用你自己的 provider 凭据。

**1 · 安装 Pi**（已安装可跳过）并配置 provider：

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi  # 然后 /login 或配置一个 provider
```

**2 · 安装桥接。** npm 版本（0.7.8）落后于 `main`，要用到下面的全部功能请从源码安装：

```bash
git clone https://github.com/Nyarlathoteppppp/pi-durabletask-mcp.git
cd pi-durabletask-mcp && npm ci && npm run build
```

<details>
<summary>或者用 npm 版本</summary>

```bash
npm install -g pi-durabletask-mcp
```

之后把下面命令里的 `node …/dist/index.js` 换成 `pi-durabletask-mcp`。

</details>

**3 · 连接。** Claude Code：

```bash
claude mcp add --scope user pi -- node /absolute/path/pi-durabletask-mcp/dist/index.js
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.pi]
command = "node"
args = ["/absolute/path/pi-durabletask-mcp/dist/index.js"]
```

更新桥接或 Pi 之后要重连 MCP。[其他客户端 →](docs/reference.md#other-mcp-clients)

**4 · 试一下：** "用 Pi 检查认证模块有没有漏掉权限检查，只读。" `init` 会显示可用模型和当前设置，`models` 列出委托能用哪些模型。

<details>
<summary>可选：安装 Agent Skill</summary>

这个 [skill](skills/pi-durabletask-mcp/SKILL.md) 教你的 agent 怎么用这套工作流。把 `SKILL.md` 放进客户端的 skills 目录：

```bash
dir="$HOME/.claude/skills/pi-durabletask-mcp" # Claude Code
# dir="$HOME/.agents/skills/pi-durabletask-mcp" # Codex 改用这一行
mkdir -p "$dir"
curl -fsSL https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/skills/pi-durabletask-mcp/SKILL.md \
  -o "$dir/SKILL.md"
```

</details>

## 能做什么

**委托**
- `spawn` 派一个任务；`spawn_batch` 一次最多派四个，多模型审查时可以共用一个 `prompt`；`run` 用于快速的阻塞式提问。
- `forkFrom` 从已结束的会话分叉：读一次代码，再从同一份上下文出发问几个独立的问题。
- 用 `attachments` 传材料（diff、笔记）；每个任务可以单独加[指令文件和 skill](docs/reference.md#explicit-instructions-and-skills)，或者[联网研究和 MCP 工具](docs/optional-tools.md)。

**控制与追问**
- `wait` 在有进展、有提问或结束时返回（`until: "settled"`，批量时可以等任意一个或全部）；`status` 给出快照，带 `idleMs` 和 `phase`，能分清是在慢慢思考还是请求挂住了。
- 运行中用 `steer` 改方向，用 `answer` 回答它的提问；结束后用 `follow_up` 继续，可以续预算；需要时 `abort`。

**结果**
- 默认返回精简结果；`saveTo` / `saveDir` 把长报告写进文件，只返回路径。
- `answerState` 标出空答案或被截断的答案；`usage` 给出 token 用量和费用。

**可靠性**
- 轮次、时间和工具调用三重预算；用到 75% 时提醒收尾，最后一轮去掉工具。
- [备用模型](docs/reference.md#continuing-on-another-model-after-a-provider-error)（可选）：Pi 自动重试后仍然是 provider 错误（网关超时、额度用完）时，换成你列出的下一个模型继续，例如 `PI_DELEGATE_FALLBACK_MODELS="xai/*:high,antigravity/gemini-*"`。
- [Durable 任务](docs/reference.md#recovery-after-a-server-restart)（可选，`durable: true`）：SQLite 检查点、重启后恢复、结果未知的副作用不会被盲目重放；`handoff` 给另一个窗口留交接笔记。

**团队（进阶）**
- 可选的 [coordinator](docs/workflows/codemode-coordinator.md)：按你的计划派发只读成员，针对分歧追问，最后给出一份汇总，并附上原报告的链接。大多数情况下，`spawn_batch` 加上你自己的判断更简单。

## 我们的实际收益

这个项目本身就是用它开发的：仓库里的审查、设计讨论和调研，每天都通过这些工具来做。

**亮点**

- **Claude 的额度花在判断上，不花在读代码上。** 发布前那轮审查，四个 agent 在 Gemini、Grok 和一个 GPT 模型上一共读了大约两百万 token 的代码，我们的 Claude 会话只收到约 7 KB 的报告，把轮次留给了决定修什么。
- **本来就在付费的订阅承担了重活。** 大部分运行交给我们本来就有的 Gemini 和 Grok 套餐。那轮审查里四次 Gemini 运行（一次审查、三次验证），按 API 价格折算约 0.1 美元，在套餐内不额外花钱。
- **多个模型家族找到的问题更多，验证让结论站得住。** 不同家族并行审查，会暴露不同的问题；再由独立验证者推翻站不住的结论。发布前那轮里，验证者推翻了一个审查者排在第一的 major，确认了两个恢复相关的真 bug，当天就修好了。
- **provider 掉链子，任务照样跑完。** 网关超时、额度用完，以前每次都要手动救。配置备用模型之后，Codex 额度用完会在几秒内切到 Grok 继续，会话不变。
- **读一次，问多次。** 从一个已经读过代码的会话 fork 出来，一轮就给出了结论。

**教训**

- 意见一致不等于正确：曾经四个审查者里有两个报了同一条误报。动手修之前先验证（[做法](docs/workflows/review-and-synthesize.md)）。
- 跨 provider 时提示缓存不会延续，上下文很大的 fork 可能比预想的贵。
- 有的模型在工具已经去掉后仍然会调用工具；可选的作答宽限能避免这种情况让运行以空结论结束。
- 快模型便宜但轮次多，推理强的模型可能想到超时。长审查要留足时间，思考档位不要开到最高。
- 任务的 `label` 不会发给委托，每个任务不同的部分要写进 `prompt`。

## 默认是安全的

- 默认只给只读工具（`read`、`grep`、`find`、`ls`），服务器用 `PI_DELEGATE_ALLOW_TOOLS` 放开才会有更多。这不是沙箱：拿到 `bash` 的委托能做你能做的任何事。
- 敏感路径（`.env`、`~/.ssh`、各类凭据）在附件、读取和搜索里都会被拒绝。
- 默认是内存会话，MCP 进程退出就结束。Durable 存储、备用模型和作答宽限都默认关闭，要自己打开。
- 每个服务器进程最多同时运行四个委托（`PI_DELEGATE_MAX_CONCURRENT`）。

## 文档

- [详细文档](docs/reference.md)：[工具](docs/reference.md#tools)、[配置](docs/reference.md#configuration)、[认证](docs/reference.md#auth)、[原生 MCP](docs/reference.md#native-mcp)
- [并行审查与汇总](docs/workflows/review-and-synthesize.md)，包括动手前先证伪审查结论
- [恢复、所有权与保留](docs/reference.md#recovery-after-a-server-restart) · [交接](docs/reference.md#handing-over-between-windows)
- [开发](docs/reference.md#development) · [更新日志](CHANGELOG.md) · [Issues](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/issues)

---

[MIT](LICENSE) · 基于 [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp) 和 Pi Durable。
