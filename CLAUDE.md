# 开发交接（2026-10-04）

修改 Worker、取消或恢复逻辑前，先读 [生命周期与持久化时序](docs/worker-lifecycle.md)。其中列出了完成条件、SDK 事件顺序和对应测试。

## 待办：可选的 Jev 语义判断（存活信号发布之后再做）

奈亚子提议（2026-10-05）。只作为可选项，默认关闭（例如 `PI_DELEGATE_JUDGE=jev`）；判断失败或超时一律当作没有判断，不影响主流程。key 优先用官方 TypeSafe 的 `TYPESAFE_API_KEY`（/Users/ywbw/workplace/pi/.env），OpenRouter 作备用；可以复用 ~/workplace/pi-jev-context 的调用代码。
- 结论质量：最终 `lastText` 是完整结论、半截，还是"Let me look at…"这类过渡语（GLM、Gemini 都遇到过），给调用方一个提示，让它用 `follow_up` 补完。
- 原地打转：根据最近的工具调用和思考内容判断是否在重复、没有进展，是的话提前发收尾 steer。
- 存活诊断（奈亚子的想法）：`status({sessionId, diagnose: true})` 按需调用 Jev。输入是服务端已有的客观数据（`idleMs`、`phase`、轮数、最近的工具调用、重试记录、最近几百字的思考或输出），输出一个判断（正在推进 / 慢慢思考 / 原地打转 / 挂起 / 在等工具）和一条建议（继续等 / steer 收尾 / 中止后 follow_up）。明确的情况由规则直接判，比如长时间没有任何流式输出就是挂起；Jev 只处理规则判断不了的，比如"有输出但在打转"。依赖存活信号先落地。

astra 的建议（2026-10-05）。约定：每个判断只输出一个字段，取值是固定枚举；Jev 超时或出错就省略这个字段，不输出分数、理由或任何说明文字。
- 值得做：`answerState: complete|partial|narration`；`progressState: advancing|looping`（先用确定性规则检查重复调用）；`liveness: progressing|thinking|looping|stalled|tool_wait`（只处理有输出但判断不清的情况；长时间无事件、工具在跑、关机这些仍走规则）。
- 可选：`modelTier: fast|balanced|strong`（spawn 前判断任务难度，再映射到配置好的模型）；`providerAction: retry|switch|stop`（只在 Pi 的确定性重试之后、针对不透明的错误）；`questionNeed: user|agent`（委托提的问题是否真的需要用户来决定）。
- 不做：`nextAction`、模型是否存在、思考档位、附件校验、"长时间无事件"、已知的 HTTP 瞬时错误重试。这些用规则就够了。

## PiWorker 运行状态重构（2026-10-05，未发布）

- 本轮之前遗留的 28 个文件已单独提交为 `ac6a98c`；本轮只重构单次运行控制状态。
- `src/pi/run.ts` 的 `WorkerRun` 集中管理计时器、收尾/provider/retry 标记、取消、最终提交与 completion。每次 `beginDurable` 创建新对象；旧控制回调只清理自己，不能改变新运行。SDK 事件、journal、steering、工具结果与暂停标记继续由 Worker 持有。
- 创建失败会释放 `settling`；取消从保存开始到 SDK drain 结束一直占用容量，保存失败仍取消 SDK。最终 catalog 写入失败保留答案、显示 error，completion 不拒绝。计时器/事件发起的取消失败记为 warning。
- MCP API、checkpoint/SQLite schema、ownership、恢复与清理语义不变；轮数累计，follow_up 的时限仍在认证后重置，恢复保留原时钟。删除了仅增减而从未读取的 `runTurns`。
- 验证：`npm test` 完整 33 组通过。新增 `worker-run.mjs` 的 6 个定向场景；其中创建失败、旧完成回调、已派发旧计时器、取消写入失败已验证旧实现失败。已有 `start-cancel` 增加创建中取消的容量断言，覆盖 MemoryJob 与真实 DurableJob。
- 灵算 Astra 提供架构建议；反重力 3.8 Flash（最高支持的 high）检查测试覆盖；Pi Codex 6.1 Sol 读取实际 diff 后未发现确定回归或冗余防御。外部审查为静态阅读，完整测试由主会话执行。本地 dist 已构建；旧 MCP host 要重连，版本仍为 0.5.0。

## 本地未发布改动（2026-10-05）

- 已修 `.env` 等敏感名字的符号链接绕过，以及原生 MCP 异步注册后重新出现在最后一轮的问题。
- `sessions(cwd)` 查项目内 loaded/stored 历史；`status/wait/sessions/handoff` 返回剩余轮数与状态/预算可继续提示。预算耗尽的交接用 `status_then_spawn`；认证、并发与归属仍在实际调用时检查。
- `spawn/follow_up/spawn_batch` 保留 `next` 字段但缩短提示；MCP `run` 默认用和 `wait` 相同的精简结果，完整答案、错误、用量与可继续提示保留。需要模型、配置或全部工具轨迹时传 `verbose: true`。
- `sessions` 与 `status/wait` 共用最终提交期间的状态投影，state 筛选也按对外状态进行；`sessions(verbose: true)` 返回完整轨迹和 notices。模型分页提示明确使用 `offset: nextOffset`；init、随包/本机 skill 与双语 README 已去掉“一定有答案”的承诺。
- 轮数仍累计。未来改成每 run 预算时，要持久化 run 的起始轮数，并恢复上轮收走的工具；不能直接复用恢复时会清零的 `runTurns`。

灵算 Astra 架构审查指出的交接 hint 矛盾与重复 catalog 查询已修复并复核通过；反重力 3.8 Flash 未发现新增确定 bug。类型检查、构建及 handoff、wait-finalization、core、retention 定向测试通过，未跑完整套件。

精简输出这一轮另通过 core、usability、integration、native-mcp 四组定向测试及类型检查/构建。usability 覆盖 `run` 默认省略配置/轨迹但保留答案与用量，以及 `verbose` 返回全部 7 次调用的 id 和结果。源码和本地 dist 已更新，版本仍为 0.5.0，未发布。

输出提示建议：在 caller prompt 中要求简短、结论先行、必要证据/文件行号、测试范围和待决策事项，省略探索过程/长日志/任务复述；关键发现或阻塞允许短进度。Pi Codex Astra 起草了 README 修订和提示词。暂未向 Worker 添加固定输出模板；prompt 可以约束模型正文，不能控制服务端 notices 或 wait 重复返回。

本轮 sessions 修复通过 wait-finalization、usability、core、handoff 四组定向测试及类型检查/构建，未跑全套。随包与本机 skill 仅修改正文；quick_validate 因 Python 缺 PyYAML 无法运行，frontmatter 已核对，未变动。

## 0.5.0：第一批使用反馈

来自另一个窗口把它当审查工具用的反馈：Gemini 跑满轮数后结果全丢；思考档位查不到；diff 不好传；看不到 token 和费用。对应地做了：最后一轮不给工具、`attachments`、`models.thinkingLevels`、结果里的 `usage`。没有做：给审查者开执行测试的权限（`PI_DELEGATE_ALLOW_TOOLS=bash` 是完整 shell，不是沙箱）、放宽 `wait` 的 55 秒上限、MCP 进度通知。

## 0.4.0：开始日常使用

0.4.0 = 0.3.9 的修复，加上按时间发的收尾 steer（时限用到 75% 且仍在调用工具时，发一次；之前 grok xhigh 读大上下文时，曾 4 次在 900 s 时限到达时没有任何输出）。到此停止加功能，在真实使用里观察 Claude/Codex 是否会：

- 忘记用 `durable: true`（之后才想交接时，原会话接不上）
- 分不清该用 `wait` 还是 `status`
- 把 `steer` 和 `follow_up` 用混
- 用 `handoff` 接手不顺

遇到问题记在这里，攒够了再决定改什么。

## 0.3.9 收尾审查

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
