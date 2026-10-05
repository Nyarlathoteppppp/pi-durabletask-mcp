<p align="center">
  <img src="https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/docs/assets/hero.png" alt="pi-durabletask-mcp — 委派、转向、恢复" width="900" />
</p>

<div align="center">

[English](README.md) · **简体中文**

# pi-durabletask-mcp

让 Claude Code、Codex 或其他 MCP 客户端把任务交给 [Pi Coding Agent](https://pi.dev)，在独立上下文中完成。

[![npm](https://img.shields.io/npm/v/pi-durabletask-mcp)](https://www.npmjs.com/package/pi-durabletask-mcp)
[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[快速开始](#快速开始) · [详细文档](docs/reference.md)

</div>

## 用法示意

```text
你：让 Pi 审查认证代码，找出遗漏的权限检查，不要改文件。
    显式设置 durable: true，之后要换窗口继续。
  → spawn，传入仓库绝对路径 cwd 和 durable: true
执行中：重点看租户隔离，先别管代码风格。
  → steer
审查结束后：针对最严重的问题，建议一个回归测试。
  → follow_up，沿用同一会话
换窗口前：保存发现的问题和下一步 → handoff save
新窗口：读取这个仓库的交接笔记 → handoff read，按 resumeHint 操作
```

收取结果时，主代理循环调用 `wait`，设置 `until: "settled"`。如果 Pi 提问，先用问题 ID 调用 `answer`，再继续等待。

## 能做什么

- **独立上下文：** Pi 读文件、搜代码，主代理收取结论。
- **附件：** 用 `attachments` 按路径传入 diff 或说明，不必把内容贴进提示词。
- **多模型批量任务：** `spawn_batch` 一次启动多个任务，每个任务可单独选模型。
- **实时调整：** `steer` 在当前工具调用结束后调整执行方向。
- **继续追问：** `follow_up` 沿用同一个长期会话的上下文，轮次累计。
- **末轮收尾：** 最后一轮禁用工具，要求模型收尾回答；结果附带 token 用量和费用。
- **按需恢复：** 显式传入 `durable: true`，将检查点存入 SQLite。
- **跨窗口交接：** 用 `handoff` 给下个 Claude/Codex 窗口留笔记。
- **原生 MCP：** `nativeMcp` 显式选择服务和工具权限；第三方扩展单独开启。

## 快速开始

**需要 Node.js 22.19+ 和全局安装的 Pi。** CI 覆盖 Pi **1.0.0 和 1.0.2**。模型调用使用你自己的供应商认证和额度。

### 1 · 安装

已经配置好 Pi？直接安装桥接服务：

```bash
npm install -g pi-durabletask-mcp
```

<details>
<summary>先安装并配置 Pi</summary>

桥接服务会链接到全局 Pi SDK，因此要先装 Pi，再装桥接服务：

```bash
npm install -g @earendil-works/pi-coding-agent@1.0.0
pi  # 配置模型供应商，或通过 /login 登录
```

搜索使用 Pi 下载的 `rg`，或 PATH 中的 ripgrep。[认证说明 →](docs/reference.md#auth)

</details>

<details>
<summary>从源码安装</summary>

仍需全局安装 Pi。

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

主代理调用 `spawn` → `wait(until: "settled")`，遇到问题用 `answer` 回复。接着可以试上面的调整方向和追问提示词。`init` 仅用于可选诊断，`models` 用于查看可用模型。

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
