<p align="center">
  <img src="docs/assets/hero.png" alt="pi-durabletask-mcp — 委派、转向、恢复" width="900" />
</p>

<div align="center">

[English](README.md) · **简体中文**

**让 Claude Code、Codex 和其他 MCP 客户端调用 Pi 子代理。**

后台委派 · 实时转向 · 可选 SQLite 恢复 · Pi 原生 MCP

[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[快速开始](#快速开始) · [重点功能](#重点功能) · [详细文档](docs/reference.md)

</div>

## 把任务交给 Pi

主代理把工作交给 [Pi Coding Agent](https://pi.dev)，查看进度并收取结果。
执行中可以调整方向，结束后可以沿用同一会话继续提问。

| 委派 | 转向 | 恢复 |
| :--- | :--- | :--- |
| 单个或批量任务，后台执行。 | 调整正在进行的工作。 | 使用 `durable: true`，在桥接服务重启后恢复。 |

## 快速开始

**需要 Node.js 22.19+ 和 Pi 1.0.0。** 搜索使用 Pi 下载的 `rg`，或 PATH 中的 ripgrep。

### 1 · 安装

```bash
npm install -g @earendil-works/pi-coding-agent@1.0.0
pi  # 配置模型供应商，或通过 /login 登录

git clone https://github.com/Nyarlathoteppppp/pi-durabletask-mcp.git
cd pi-durabletask-mcp
npm ci
npm run build
```

### 2 · 连接

将 `/absolute/path/pi-durabletask-mcp` 换成仓库的绝对路径。

**Claude Code**

```bash
claude mcp add --scope user pi -- node /absolute/path/pi-durabletask-mcp/dist/index.js
```

**Codex** — 在 `~/.codex/config.toml` 中加入：

```toml
[mcp_servers.pi]
command = "node"
args = ["/absolute/path/pi-durabletask-mcp/dist/index.js"]
```

已配置过就更新原有条目，再重连 MCP 服务。[其他客户端 →](docs/reference.md#other-mcp-clients)

### 3 · 委派

> 让 Pi 审查这个仓库，报告发现的问题。

主代理会调用 `init` → `spawn` → `wait` / `status`。
Pi 默认使用你配置的模型和**只读工具**。[模型与权限 →](docs/reference.md#configuration)

## 使用方式

需要在桥接服务重启后恢复时，要求主代理创建**持久化任务**，或向 `spawn` 传入：

```json
{
  "cwd": "/absolute/path/to/repo",
  "prompt": "审查这个仓库，报告发现的问题。",
  "durable": true
}
```

<details>
<summary><strong>全部 13 个工具</strong></summary>

| 操作 | 工具 |
| :--- | :--- |
| 开始任务 | `spawn` · `spawn_batch` · `run` |
| 查看进度 | `status` · `wait` · `sessions` |
| 调整方向或继续会话 | `steer` · `follow_up` |
| 回答、停止或删除 | `answer` · `abort` · `forget` |
| 查看配置 | `init` · `models` |

</details>

子代理也能使用指定的 **Pi 原生 MCP 服务**，工具权限由显式白名单控制。
[原生 MCP 配置 →](docs/reference.md#native-mcp)

## 重点功能

- **任务随时可控。** `spawn_batch` 批量启动子代理；`steer` 调整执行中的方向；`follow_up` 沿用同一会话继续工作。
- **持久化任务只有一个执行者。** 使用由内核释放的 SQLite 锁。进程崩溃后可接管任务，不依赖 PID 身份，也不让两个执行者同时领取。
- **Pi 原生 MCP。** 每个子代理选择服务和具体工具权限，支持 `codemode`、`tool_search`；第三方扩展单独开启。
- **轮询输出精简。** `status` / `wait` 默认只显示最近 5 次工具调用及总数；`verbose: true` 可查看完整轨迹。
- **预算与自动清理。** 可设轮次、时长上限；持久化历史默认保留 7 天，`retentionDays` 可按任务调整，空间不足时可能提前清理已完成历史。
- **复用你的 Pi 配置。** 共用全局 Pi SDK 和供应商配置，每个子代理可以选模型；供应商自动重试会显示在状态通知中。

[配置项 →](docs/reference.md#configuration) · [任务归属与保留策略 →](docs/reference.md#ownership)

## 恢复的边界

任务**默认只在内存中**。开启 `durable: true` 后，SQLite 保存会话历史、工具结果和待发送指令。
未完成任务在服务重启后恢复；已完成历史保留到清理策略生效。

中断的工具可能有**结果未知**的外部副作用。桥接服务不会盲目重放，重试前应检查实际状态。
恢复仍受原有预算限制，停机时间计入当前运行的时长上限。
[恢复与保留策略 →](docs/reference.md#recovery-after-a-server-restart)

<details>
<summary><strong>更新 Pi</strong></summary>

执行 `pi update --all` 后，在仓库运行 `npm test`，再重连 MCP 服务。
桥接服务共用全局 Pi SDK；Pi Durable 独立固定版本。

</details>

---

<div align="center">

[详细文档](docs/reference.md) · [开发说明](docs/reference.md#development) · [更新记录](CHANGELOG.md) · [问题反馈](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/issues)

[MIT](LICENSE) · 基于 [howznguyen/pi-delegate-mcp](https://github.com/howznguyen/pi-delegate-mcp) 和 Pi Durable。

</div>
