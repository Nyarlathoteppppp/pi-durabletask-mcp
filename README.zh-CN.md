<p align="center">
  <img src="https://raw.githubusercontent.com/Nyarlathoteppppp/pi-durabletask-mcp/main/docs/assets/hero.png" alt="pi-durabletask-mcp — 委派、转向、恢复" width="900" />
</p>

<div align="center">

[English](README.md) · **简体中文**

# pi-durabletask-mcp

让 Claude Code、Codex 或其他 MCP 客户端通过 [Pi Coding Agent](https://pi.dev) 协同调用不同 provider 的 AI：分工执行、讨论方案、集中汇总。单个任务交给一个代理，一组任务交给一个团队。

[![npm](https://img.shields.io/npm/v/pi-durabletask-mcp)](https://www.npmjs.com/package/pi-durabletask-mcp)
[![CI](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyarlathoteppppp/pi-durabletask-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-30343b?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-e78260.svg)](LICENSE)

[快速开始](#快速开始) · [详细文档](docs/reference.md)

</div>

## 用法示意

```text
你 → Claude / Codex / 其他 MCP 主模型：
  “让 Pi 团队审查这次认证改动。分配一个代理检查权限，一个用 Exa 联网查证，
   一个脑暴测试方案。按任务选择可用的 provider/model ID，不要改文件。
   对冲突的说法定向追问，汇总证据、分歧与遗漏，保留完整报告供按引用查阅。”
主模型 → Pi 指挥/汇总模型（调用方给出任务分工）
           ├─ 为代码审查选择的 provider/model
           ├─ 为联网研究选择的 provider/model（显式开启 Exa）
           └─ 为测试脑暴选择的 provider/model
         → 定向追问 → 汇总结论 + 原始报告引用
```

单个任务也可直接交给普通 delegate；显式授权工具后，还能编辑文件、执行命令。

## 能做什么

- **跨 provider 的代理团队：** 用 `models` 为不同角色选模型；单任务交给一个代理，多任务用 `spawn_batch` 并行派发。
- **[指挥者负责派发和汇总](docs/workflows/codemode-coordinator.md)：** 给出任务分工，由 Pi 收取报告、定向追问、汇总结论，保留来源与分歧。Codemode 支持循环、条件和并行调用。
- **读一次，探索多个方向：** `forkFrom` 让独立分支沿用已结束会话的上下文，每个分支获得新预算。
- **讨论与迭代：** 执行中用 `steer` 调整方向，结束后用 `follow_up` 继续讨论，并按需补充预算。
- **报告不用手动搬运：** `attachments` 按路径传材料，`saveTo` 保存结果；主模型收取摘要和原始报告引用。
- **授权实现：** 给普通代理开放编辑或命令工具，结果包含成功修改的文件路径、token 用量和费用。
- **[联网研究](docs/research.md)与原生 MCP：** 选择服务和工具权限，可开启 Exa 搜索与抓取；Pi 第三方扩展单独配置。
- **进度与恢复：** 用 `idleMs` 和 `phase` 看执行状态，以轮数、工具次数和时间限制任务；可选 `durable: true` 为单会话保存 SQLite 检查点，`handoff` 帮助跨窗口接手。

目前指挥者团队为一层编排、内存会话，子代理只读，可开启 Exa 联网研究。团队模式需授权 `codemode` 并传入 `tools: ["codemode"]`；[示例](docs/workflows/codemode-coordinator.md)包含分工与配置方法。

## 快速开始

**需要 macOS 或 Linux、Node.js 22.19+ 和全局安装的 Pi。** CI 覆盖 Pi **1.0.0 和 1.0.4**；不支持 Windows。模型调用使用你自己的供应商认证和额度。

### 1 · 安装

上面的团队编排流程已在 **GitHub main**，请用下方的源码安装方式；当前 npm 版本为 **0.7.8**。

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
