# 开发交接（更新于 2026-10-10）

修改 Worker、取消或恢复逻辑前，先读 [生命周期与持久化时序](docs/worker-lifecycle.md)。其中列出了完成条件、SDK 事件顺序和对应测试。历史经过看 `CHANGELOG.md` 和 git 记录，这里只记当前状态和仍然有效的经验。

## 当前状态

- 版本：GitHub release 到 v0.7.11；npm 停在 0.7.8，暂不发 npm。未发布的改动记在 `CHANGELOG.md` 的 Unreleased。
- 结构：
  - `src/core.ts` 编排入口、批次和 fork；`src/registry.ts` 管并发、持有和恢复；`src/durable.ts` 管 Harness 检查点、catalog 和内核锁；`src/coordinator.ts` 是团队编排。
  - `src/pi/worker.ts` 是 PiWorker 的有状态核心（start、beginDurable、track、onEvent、abort、suspend）；`run.ts` 是单次运行的控制状态（WorkerRun）。
  - `session.ts` 构造 Pi 会话（资源加载器、扩展顺序、工具白名单）；`snapshot.ts` 是精简结果；`repair.ts` 修复检查点；`prompts.ts` 放最后一轮、收尾和 provider 拒绝文本。
- 测试：`npm test` 跑 `test/offline.mjs`，54 组（输出 70 行 OK），约 4 分钟；单跑用 `node test/offline.mjs <组名>`。

## 工作方式

- 先核实问题确实存在；先写在旧代码上失败的测试，修完做变异检查，再跑全套。
- 别的 agent 可能同时在改这个仓库：动手前看 `git status`，只提交自己的文件。
- 推送和发布听用户的：推送 = push；发布 = tag + GitHub release。版本号按补丁号小步递增。
- 不因理论上的极限情况加门禁、回退或防御，按当前 diff 和测试结果判断。
- 正在运行的 MCP host 不会热加载新代码和工具描述，改完要重连。

## 用 pi 委托的经验

- 审查：把 diff 写成文件放进 `attachments`，写明检查点，要求只报确定的问题并限制字数。同一个 prompt 发给多个模型，用批次级 `prompt`。
- 审查结论要逐条核实。常见误报是理论竞态，比如"await 之前捕获了某个字段"，实际上那个字段只在启动前赋值。
- 模型：灵算 astra 适合讨论设计；Codex 6.1 sol 有额度时审查和干活；反重力 3.8 Flash 免费，但轮次和 token 用得多；grok 用 medium、`maxDurationMs: 900000`；GLM 很慢，用 low thinking 加检查清单。委托不用 openrouter 的模型。
- 轮询：`wait` 一次只发一个，同一批发多个会同时返回。`idleMs`/`phase` 能分清是慢思考还是挂起。`termination.reason: deadline` 之后如果还有轮次，用 `follow_up` 让它根据已读内容直接总结。
- 判断有没有结论时，先对 `lastText` 做 trim。

## 已定的设计决定

- `maxToolCalls` 只计模型自己的调用，codemode 或 MCP 工具内部的嵌套调用不计。provider 重试不计轮次。`follow_up` 可以续 `maxTurns`/`maxToolCalls`。
- codemode 是 opt-in。2026-10-06 用 3.8 Flash 做过对比，codemode 没有省 token，表现也不稳定。
- answerState：`missing`、`partial` 由规则判断；Gemini 过滤器的固定文本按规则判为 `narration`。Jev 是 opt-in（`PI_DELEGATE_JUDGE=jev`），概率 ≥ 0.95 才报 `narration`。0.95 是看过留出集之后选的，还没有用第三轮留出集验证，见 `bench/answer-state/README.md`。
- 不做：
  - 给审查者开 `bash`（它是完整的 shell，不是沙箱）；
  - 放宽 `wait` 的 55 秒上限；MCP 进度通知和 MCP Tasks；
  - autoContinue，暂缓，见 `docs/design/fork-and-auto-continue.md`；
  - 只为了行数继续拆 worker.ts。

## 待办

- 崩溃窗口覆盖（2026-10-10 核对）。不变量：同一任务最多一个所有者；已完成的不重跑；结果未知的工具调用不重放。各窗口由以下测试覆盖：
  - catalog 已插入、Harness 还没建：`crash-windows.mjs` 用例 1，从原始 prompt 重跑；
  - 工具执行开始、结果未落盘：`recovery.mjs`（TOOL_BARRIER）、`native-recovery.mjs`（嵌套调用）；
  - 答案已存、终态未提交：`review-claims.mjs`（CRASH_AFTER_ANSWER）；
  - 终态已提交、catalog 未记录：`retention.mjs`（CRASH_BEFORE_FINAL）；
  - follow_up 已提交：`retention.mjs`（CRASH_AFTER_FOLLOWUP_COMMIT），续预算的情况见 `crash-windows.mjs` 用例 2；
  - 恢复中再崩溃、超过次数上限：`ownership.mjs`、`recovery-failure.mjs`；关闭到释放之间：`ownership.mjs`（CLOSE_BARRIER）；
  - 认领竞争：`claim-race.mjs`；没有 catalog 行的存储：`orphan-gc.mjs`；
  - `saveTo` 用临时文件加 rename，崩溃不会留下写了一半的目标文件。

  已知且接受：Jev 判断期间崩溃，恢复后不再重新判断 `narration`（opt-in 的提示性字段）；`saveTo` 只保存在内存，恢复后的结果直接返回。故障钩子都在 `test/recovery-server.mjs`，新窗口优先加在那里。
- Jev 的其他用途（存活诊断、识别原地打转）还没做。约定：每个判断只输出一个枚举字段，失败或超时就省略；规则能判断的不交给 Jev。
- sdk-link 并发启动时偶发 `EINVAL`：2026-10-10 全套测试里出现 1 次，之后 39 次都没复现。原因是 `realpathSync` 正好碰上另一个进程在重命名 symlink。再出现就修：读链接失败时当作需要重新链接。

## 环境注意

- 测试跑到一半时升级全局 Pi SDK，符号链接会短暂消失，导致测试失败，重跑即可。
- stdio 入口在连接之前恢复任务；嵌入 `createServer()` 的调用方要自己负责启动恢复。
