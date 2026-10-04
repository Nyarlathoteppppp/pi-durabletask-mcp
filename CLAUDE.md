# 开发交接（2026-10-04）

## 最新结论：0.3.9 收尾审查

Pi 的 `openai-codex/gpt-6-astra` 独立只读审查，Codex 核实并修复；Astra 对补丁再次复核，未发现新的确定问题。当前适合本机 Claude/Codex 的实际委派工作流；本轮没有发现需要架构重写或扩大防御的依据。

- 修复认证/task creation 等待期间取消后仍启动模型的问题，durable 取消结果正确落盘。
- 修复 `wait(settled)` 提前于最终提交返回的问题，超时期间保持 `running`，完成后可立即 `follow_up`。
- 修复懒加载期间 `forget` 漏清理资源及并发 `follow_up` 使用已删除 worker 的问题。
- 本轮实际遇到 75% 轮次提醒导致审查漏读必要源码：提醒改为只做必要核验并预留结论轮次，硬上限不变。

验证：构建通过；8 组定向测试通过（start-cancel、wait-finalization、unload-race、core、lifecycle、regressions、integration、recovery）。三个修复场景先确认旧实现失败，再验证修复；认证/task creation 取消覆盖内存和真实 DurableJob，恢复测试使用真实 MCP/Pi SDK 与本地假 provider。未运行完整套件、压力测试或真实写入任务。

使用建议：短审查/查询保持默认内存任务；需要跨重启或跨窗口继续时显式 `durable: true`，交接用 `handoff`。继续使用 `spawn → wait(until: "settled")`，有问题先 `answer`，结束后再 `follow_up`。当前仍运行的 MCP host 要重连才能加载这次修复。

## 历史结论：0.3.3 审查

审查发布提交 `bc512f7`（对比 0.3.2 的 `cfb274f`）。Pi 的 `openai-codex/gpt-6-astra` 独立只读审查，Codex 随后核实。建议先做小修，不需要架构重写。

1. **P1：恢复领取使用 await 前的容量/关机状态。** `src/registry.ts:165` 等待 `claimAbandonedSettled()`，其 jitter 期间新任务可占满容量，或 `suspendAll()` 已完成快照；返回后仍直接注册恢复 worker。小复现确认：并发上限 1，实际 active 为 2；另一复现确认：`suspendAll()` 后仍注册 worker 并调用恢复入口。应在重试后重新读取容量和关机状态，再同步领取并预留；避免在已增加 recovery attempts 后才丢弃超额领取。
2. **P2：竞态测试的 child 分支继续执行 parent 流程。** `test/claim-race.mjs:15` 只安排延迟退出，未阻止继续执行第 18 行以后的建目录和派生子进程逻辑。代码静态确认，未运行递归压力测试。用互斥的 child/parent 分支，保留原有持锁时间即可。
3. **P2：短模型 ID 被错误显示为不可用。** `src/pi/models.ts:75` 原样返回 `PI_DELEGATE_MODEL`，models 将它与 `provider/id` 比较。真实 SDK + 本地假 provider 的小复现：`defaultUsable:false`，但省略模型的任务成功完成，实际模型是 `review033/audit-default-short`。复用实际模型 lookup 的规范化结果，不要禁用已有短 ID 用法。

小建议：为 batch wait 补问题打断 `all_settled`、取消等待不取消 worker 的定向测试；结果收集提示应明确先回答问题，再继续等待。

本轮没有修改实现，也没有跑完整/大压力套件。容量/关机复现使用真实 catalog、内核锁和 registry，仅 stub SDK 执行；模型复现使用真实 SDK 和本地假 provider。脚本在 `/tmp/pi-033-review-race.mjs` 和 `/tmp/pi-033-review-model.mjs`，临时状态已清理。审查期间另有后续改动进入工作区；以上结论针对 `bc512f7`，未覆盖或提交其他会话的改动。

## 0.3.2 实现记录

优先降低 Claude/Codex 的操作成本。收益最高的是取消强制 `init`，并用短指令说明已有工作流。

- 工具直接可用；`init` 只做可选配置/认证诊断。任务启动时的权限和认证检查保留。
- Pi SDK 自选的默认模型也走现有 allowlist、denylist、项目 scope 校验，在请求模型前拒绝违规选择。
- `wait` 遇到 pending question 提前返回；取消等待不停止 worker。取消 `run` 会停止其 worker。
- 已补工具 annotations、精简 server instructions 和使用说明；作者本机 Codex/Claude 共用的 `pi-coding-agent` skill 已同步。
- 0.3.2 当轮未增加执行能力，未改 durability、ownership、recovery、retention 或 SQLite 布局；当时暂缓结果指引、structured output 和 MCP Tasks。0.3.3 已新增结果指引与批量等待，不能把这条历史记录当作当前限制。

## 验证与审查

- `npm test`：23 组全部通过，包含真实 Pi SDK 的离线假 provider 测试。
- antigravity/gemini-3.8-flash 补审未发现确认 bug。xai/grok-4.7 提出两处启动清理/取消疑虑，Codex 核对 SDK 后未确认：模型检查在原生 MCP 的 session_start 之前，已有 bindExtensions 后的停止检查阻止 job 创建。不要把第一轮因预算未读完的审查当作通过。

## 接手注意

- 正在运行的 MCP host 不会热加载新代码/工具描述；需重连或新开客户端会话。
- stdio 入口在连接前恢复任务；嵌入 `createServer()` 的调用者负责启动恢复，`init` 不再触发恢复。
- 内存会话在当前 host 保留期间也能 `follow_up`；跨重启或需盘上历史才用 `durable: true`。轮次预算始终累计。
- 按当前 diff 和测试结果继续；不因理论极限新增门禁、回退或压力场景防御。
