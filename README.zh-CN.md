<p align="center">
  <img src="https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/docs/assets/hero-teams.zh-CN.svg" alt="pi-durabletask-mcp — 多模型分工，结论集中看。" width="100%" />
</p>

<div align="center">

[English](README.md) · **简体中文**

# pi-durabletask-mcp

### 多模型分工，结论集中看。

让 Claude Code / Codex 主模型制定分工，通过 [Pi](https://pi.dev) 协调不同 provider 的代理，集中收取结果。

[![npm](https://img.shields.io/npm/v/pi-durabletask-mcp)](https://www.npmjs.com/package/pi-durabletask-mcp)
[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[快速开始](#快速开始) · [团队示例](docs/workflows/codemode-coordinator.md) · [详细文档](docs/reference.md)

</div>

---

| **01 · 按任务编排** | **02 · 同起点多路探索** | **03 · 追问再汇总** |
| :--- | :--- | :--- |
| 主模型定分工，Pi 按角色派发不同模型。 | 沿用已结束会话的事实与上下文，独立探索不同方向。 | 针对分歧追问，汇总证据与遗漏，保留原报告引用。 |
| [Codemode 团队 →](docs/workflows/codemode-coordinator.md) | `forkFrom` · 独立分支与新预算 | `follow_up` · 摘要与完整报告 |

## 用法示意

> 让团队只读审查认证改动，追问分歧并汇总漏测项。

**你给目标和分工 → Pi 并行派发 → 对分歧定向追问 → 收取汇总与原报告。**

按角色选择不同 provider/model：一个查权限，一个用 Exa 联网查证，一个提出测试方案。主模型保留最终判断。[查看完整分工与配置示例 →](docs/workflows/codemode-coordinator.md)

**给分工就能开团队。** 服务端已授权 `codemode` 时，`spawn` 可默认派发、收报告并汇总：

```json
{
  "cwd": "/absolute/repo",
  "coordinator": {
    "tasks": [
      { "label": "权限", "prompt": "审查认证中的权限校验，给出具体证据。" },
      { "label": "测试", "prompt": "核对认证测试，指出确实缺失的覆盖。" }
    ]
  }
}
```

按需加模型、`forkFrom` 和 `saveDir`；传 `prompt` 可自定编排策略。
只要并行原报告、不需要汇总，用 `spawn_batch`。

## 能做什么

| | 功能重点 |
| :--- | :--- |
| **分工与探索** | **跨模型并行**：`models` 选模型，`spawn_batch` 派任务；**共享上下文**：从已结束会话 `forkFrom`；**联网研究**：按需开启 [Exa 搜索与抓取](docs/research.md)；**原生 MCP**：按需选 [GitHub、Serena、浏览器等工具](docs/optional-tools.md)，扩展单独配置。 |
| **追问与报告** | **及时调整**：执行中 `steer`，结束后 `follow_up`，按需补充预算；**材料与成果**：`attachments` 传文件，`saveTo` 存报告；收取摘要、原文引用、可选[团队报告索引](docs/workflows/codemode-coordinator.md#saved-team-index)、token 用量与费用。 |
| **授权与恢复** | **普通代理可实现**：显式开放编辑或命令工具，返回成功修改的文件路径；**项目规范**：按需选择[指令文件与 skill](docs/reference.md#explicit-instructions-and-skills)；**过程可见**：`idleMs`、`phase`、执行预算及 verbose 上下文占用；**单任务可恢复**：可选 SQLite 检查点与跨窗口 `handoff`。 |

团队支持 Codemode 循环、条件和并行调用；[每个成员可分别选择 GitHub、Serena、浏览器和 Exa 工具](docs/workflows/codemode-coordinator.md#member-mcp-tools)。目前为一层编排、内存会话，用于只读任务。服务端需授权 `codemode`，团队省略工具时会自动选择它。单个任务也可直接交给普通 delegate。

---

## 快速开始

**需要 macOS 或 Linux、Node.js 22.19+ 和 Pi（托管或 npm 全局安装）。** CI 覆盖 Pi **1.0.0、1.0.4 和 1.1.0**；不支持 Windows。模型调用使用你自己的供应商认证和额度。

### 1 · 安装

上面的团队编排流程已在 **GitHub v0.7.11**，请用下方的源码安装方式；当前 npm 版本为 **0.7.8**。

已经配置好 Pi？直接安装桥接服务：

```bash
npm install -g pi-durabletask-mcp
```

<details>
<summary>先安装并配置 Pi</summary>

桥接服务使用你已安装的 Pi SDK。托管安装适配目前仅在源码中，下次 npm 发版前请用下方源码安装方式。先安装 Pi：

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi  # 配置模型供应商，或通过 /login 登录
```

搜索使用 Pi 下载的 `rg`，或 PATH 中的 ripgrep。[认证说明 →](docs/reference.md#auth)

</details>

<details>
<summary>从源码安装</summary>

需先安装 Pi。每次更新 Pi 后重连 MCP，新桥接进程会使用当前 SDK。

```bash
git clone https://github.com/Nyarlathoteppppp/pi-durabletask-mcp.git
cd pi-durabletask-mcp
npm ci
npm run build
```

连接时用 `node /absolute/path/pi-durabletask-mcp/dist/index.js` 替代全局安装后的命令，路径换成仓库绝对路径。

</details>

### 2 · 连接

<details>
<summary>Claude Code</summary>

```bash
claude mcp add --scope user pi -- pi-durabletask-mcp
```

</details>

<details>
<summary>Codex</summary>

在 `~/.codex/config.toml` 中加入：

```toml
[mcp_servers.pi]
command = "pi-durabletask-mcp"
```

</details>

已配置过就更新原有条目，再重连。[其他客户端 →](docs/reference.md#other-mcp-clients)

### 3 · 试一次审查

> 让 Pi 审查认证代码，找出遗漏的权限检查。不要改文件；给出文件位置和建议补充的回归测试。

主代理调用 `spawn` → `wait(until: "settled")`，遇到问题用 `answer` 回复。`init` 仅用于可选诊断，`models` 用于查看可用模型。

<details>
<summary>可选：安装 Agent Skill</summary>

先连接 MCP 服务；这份 [skill](skills/pi-durabletask-mcp/SKILL.md) 只指导工具使用。选择客户端的用户级目录，仅下载 `SKILL.md`：

```bash
dir="$HOME/.claude/skills/pi-durabletask-mcp" # Claude Code
# dir="$HOME/.agents/skills/pi-durabletask-mcp" # Codex：改用这一行
mkdir -p "$dir"
curl -fsSL https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/skills/pi-durabletask-mcp/SKILL.md \
  -o "$dir/SKILL.md"
```

安装后开启新的客户端会话。

</details>

## 默认行为与恢复边界

任务使用你配置的模型，**默认只读、只存内存**；内存会话随所属 MCP 进程退出而消失。
显式设置 `durable: true` 后，任务可在桥接服务重启后恢复：停机时间计入每次运行的时长上限，结果未知的工具调用不会盲目重放，需核实外部状态后再重试。
`handoff` 保存主代理编写的笔记，读取不会接管执行。
跨窗口继续需要持久化任务、原任务历史和笔记仍保留；活着的 owner 进程必须先释放任务，其他进程才能接着执行。

## 文档导航

- [代理指令](docs/reference.md#agent-instructions) · [工具参考](docs/reference.md#tools) · [配置](docs/reference.md#configuration)
- [跨窗口交接](docs/reference.md#handing-over-between-windows) · [原生 MCP](docs/reference.md#native-mcp)
- [恢复、归属与保留策略](docs/reference.md#recovery-after-a-server-restart)
- [开发说明](docs/reference.md#development) · [更新记录](CHANGELOG.md) · [问题反馈](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/issues)

---

[MIT](LICENSE) · 基于 [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp) 和 Pi Durable。
