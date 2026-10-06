# 设计：分叉（forkFrom）与自动续一轮（autoContinue）

状态：方案，待实现（2026-10-06）。先实现第 1 部分；第 2 部分是可选的，可以单独做。

## 1. 分叉：`forkFrom`

### 要解决的问题

一个委托读代码库，常常就要花掉几十万 token（实测：Flash 做一次环境变量核对，用了 17 万到 63 万）。之后想问它几个不同的问题，现在只有两条路：

- 用 `follow_up` 一个一个地问：只能串行，而且前一个问题会影响后一个的上下文；
- 派几个独立的委托：每个都要把代码重新读一遍，token 成倍增加。

分叉的意思是：从一个已经读完代码的会话出发，分出若干个独立的新会话。每个新会话都带着同样的上下文，可以并行地问不同的问题，互不影响。新会话的开头和父会话完全一样，provider 的提示缓存通常也能命中。

### 接口

`spawn`、`run` 和 `spawn_batch` 的每个任务（也可以在批次级设置默认值）新增：

```json
{ "forkFrom": "explore-01", "prompt": "Only check the handoff code for races." }
```

- `forkFrom`：父会话的 `sessionId`。新会话从父会话**当前**的对话记录开始，再接上这次的 `prompt`。
- 下面这些不传时继承父会话：`cwd`、`tools`、`model`、`thinking`、`extensions`、`nativeMcp`、`mcpServers`。传了就覆盖，校验规则和普通 `spawn` 完全一样，包括 `pickTools`、模型的白名单/作用域/认证检查、思考档位检查。
- `durable`、`retentionDays`、`maxTurns`、`maxDurationMs`、`maxToolCalls`、`saveTo`、`attachments`、`id`、`label`：属于新会话自己，**不继承**，按普通 `spawn` 的默认值处理。
- 结果里新增 `forkedFrom: "<父 sessionId>"`，`status` 和 `sessions` 里都能看到，便于追踪来源。

典型用法（"读一次，问多次"）：

```text
spawn({ id: "explore-01", prompt: "Read src/ and summarise recovery and handoff" })
wait(explore-01) → done
spawn_batch({ forkFrom: "explore-01", tasks: [
  { prompt: "Only races" }, { prompt: "Only SQL and migrations" }, { prompt: "Docs vs code" } ] })
```

### 语义

1. **父会话必须处在空闲状态**：`done`、`aborted` 或 `error`，并且不是 `isActive`。运行中的会话，对话记录可能停在半轮（有工具调用但还没有结果），分叉出来的状态不一致，所以直接拒绝，提示"等它结束，或者先 abort"。
2. **分叉的是快照**：之后父会话再 `follow_up`，不会影响已经分出去的子会话，反过来也一样。
3. **子会话的预算从零开始计**：`turns` 和工具调用次数都从 0 开始，因为它是一个独立的新任务。但它的上下文已经很大，一开始就接近模型上下文窗口的情况要考虑到，见"风险"。
4. **跨模型分叉**：允许 `model` 和父会话不同，但这是风险点。Pi 支持在会话中途切换模型，对话记录在 pi-ai 层是统一的消息格式；不过有些 provider 的思考块带签名，或者是加密的推理内容，可能不能交给另一家 provider。实现时必须实测 openai-codex → deepseek、gemini → openai-codex 两种组合；不兼容的话，就在分叉时剥掉 thinking 块，或者直接拒绝跨 provider 分叉。
5. **父会话的来源**：
   - 已经在本进程加载的（memory 或 durable）：直接用；
   - 存在磁盘上、但还没加载的 durable 会话：通过 `resolve(id)` 加载（会认领它的锁），再分叉；
   - 被另一个 MCP 进程持有的：拒绝，和 `follow_up` 的报错一致（"loaded by another running MCP process"）；
   - 内存会话属于别的进程、或者已经被清掉：报 `Unknown sessionId`。
6. **安全**：子会话能看到的，就是父会话已经看过的内容，不会新增任何文件访问权限。工具权限按子会话自己（继承或覆盖后）的 `tools` 重新校验。父会话里读过的文件内容（包括通过附件带进来的）会原样带进子会话的上下文，文档里要写明。

### 实现要点

- **取父会话的记录**：`src/pi/worker.ts` 新增 `forkEntries(): FileEntry[]`，返回 `[sessionManager.getHeader(), ...sessionManager.getEntries()]`（和 `checkpoint()`、`repairEntries()` 用的是同一种格式）。只在 `!isActive` 并且 session 存在时允许调用。
- **会话头**：父会话的 header 里有它自己的会话 id。子会话应该生成新的 header；看 Pi `SessionManager` 能否用 `parentSession` 字段（`session-manager.d.ts` 里有 "Path to the parent session (if this session was forked)"）标明来源。**这一点要在 SDK 里先确认清楚**，不要直接复用父会话的 header。
- **创建子会话**：`PiWorker.start(prompt, saved?, key?)` 现在是用 `SessionManager.inMemory(this.cwd, undefined, saved ? repairEntries(saved) : undefined)` 建会话的。增加一个"种子记录"入口，例如 `start(prompt, { seedEntries })`，用父会话的记录来建会话，而不是用 `saved`。`inputStarted`、`results`、`steering` 都从空开始，不要复制父会话的。
- **durable 子会话**：首个检查点就包含种子记录，恢复时照常用 `repairEntries` 重建。`DurableJob` 的存储格式不需要改。
- **接线**：
  - `src/core.ts` 的 `startExecution`、`runExecution`、`startBatch`：如果有 `forkFrom`，先 `resolve` 父会话，检查它是空闲的，取出记录，再按"继承加覆盖"合成 `LaunchRequest`，最后带着种子记录调用 `launch`。批次里多个任务分叉同一个父会话时，只 `resolve` 一次。
  - `src/registry.ts` 的 `LaunchRequest`：加 `seedEntries?` 和 `forkedFrom?`。`prepare`、`makeWorker` 把它们传给 worker。`forkedFrom` 写进 `WorkerOptions`（durable 会话会持久化），`seedEntries` 不写进 options，因为它已经在首个检查点里了。
  - 工具参数：`src/tools/spawn.ts` 的 `spawnShape`、`taskShape` 和批次参数加 `forkFrom`。
- **结果**：`Snapshot` 加 `forkedFrom?`；在 `status`、`sessions`（列表）里显示。`wait` 的精简结果不用加。

### 测试（先写测试，确认在旧代码上失败）

用 `test/integration.mjs` 那种真 MCP 加假 provider 的方式：

1. 父会话读一个文件（假 provider 返回一次 `read` 调用），结束；然后分叉出两个子会话。断言：两个子会话的第一个请求里，都带着父会话的完整对话（包括那次 `read` 的结果），后面才接上各自的 `prompt`；子会话没有再次调用 `read`；两个子会话互不包含对方的问题。
2. 分叉之后，父会话再 `follow_up`：子会话的对话不受影响。
3. 父会话还在运行时分叉：被拒绝。
4. 继承和覆盖：不传 `tools`/`model`/`cwd` 时和父会话一致；传了就按新的值，而且仍然经过权限和模型校验（比如覆盖成一个没授权的工具，会被拒绝）。
5. durable 子会话：分叉后杀掉进程，在新进程里恢复，对话里仍然包含父会话的内容。
6. `spawn_batch` 带批次级 `forkFrom`：每个任务都正确分叉，父会话只被加载一次。
7. 父会话被另一个进程持有：拒绝，报错信息和 `follow_up` 一致。
8. 跨模型分叉：至少用真实的 openai-codex 和 deepseek 各跑一次（可以手动跑，不进离线测试），记录结论。

### 风险

- **上下文窗口**：父会话已经很大，子会话一开始就可能接近上限。Pi 的自动压缩会处理，但压缩会损失细节。可以在分叉时，如果父会话的 `usage` 已经接近模型的上下文窗口，就在结果里加一条 warning。
- **费用**：每个分支都要把父会话的整段上下文作为输入发给 provider。命中提示缓存时很便宜，没命中就是全价，文档里要写明。
- **跨 provider 的思考块**：见语义第 4 条。

## 2. 自动续一轮：`autoContinue`（可选）

### 要解决的问题

委托结束时，最终文本不是可用的结论：`answerState` 是 `missing`（什么都没说）或 `narration`（只说了"Let me look at…"，这需要开启 Jev）。现在只能由调用方自己发现，再手动 `follow_up`。

### 设计

- 默认开启，可以用 `autoContinue: false` 关掉（`spawn`、`run`、`spawn_batch`）。
- 只在**本次运行结束、状态将要变成 `done`、而且 `answerState` 是 `missing` 或 `narration`** 时触发，**每次运行最多一次**。
- 触发后，在同一次运行里再发一条提示："Your last reply did not give a conclusion. Answer the task now from the evidence you already have; do not start new work."。这一轮**不给工具**，复用最后一轮收走工具的 `lastTurn()`，避免它借机继续查资料。
- 剩余的 `maxTurns` 必须至少还有 1 轮，否则不续。时限不够也不续（`elapsedMs` 加上一个保守估计，比如 60 秒，超过 `maxDurationMs` 就放弃）。
- 续完之后重新计算 `answerState`（规则判断和 Jev 都重新跑），不会再续第二次。
- 结果的 `notices` 里加一条：`auto-continued once: answerState was narration`，让调用方知道这个结论是追问出来的。

### 实现要点

- 位置：`src/pi/worker.ts` 的 `track()`，在 `.then(async () => …)` 里、Jev 判断之后、写 `saveTo` 之前。现在这里会给出 `answerFlag`；加一段：满足条件就 `this.lastTurn(session)`，然后 `await session.prompt(CONTINUE_PROMPT); await session.waitForIdle();`，再重新算 `answerFlag`。所有 `await` 之后都要像现有代码一样检查 `this.currentRun !== run || this.suspended || this.termination`。
- 运行级的标记 `autoContinued` 放在 `WorkerRun` 上（`src/pi/run.ts`），每次运行各有一份。
- durable 运行：续的这一轮和普通的轮一样，会经过检查点。要确认：恢复时，如果续到一半，能正常完成或者重来（复用现有的恢复逻辑）。

### 测试

- 假 provider 第一次回复空文本、第二次回复结论：结果是 `done`，`lastText` 是结论，`answerState` 没有，`notices` 里有续过一轮的提示，第二次请求里没有 `tools`。
- 第二次仍然是空文本：不会再续第三次，最终 `answerState: "missing"`。
- 设置 `autoContinue: false`：不续。
- 已经没有剩余轮数时：不续。
- 有 Jev（用假 Jev 服务）判为 `narration`：续一次。

## 不做的事

- 不迁移到 pi-durable 的生成运行时，不做子委托、后台任务、任务树：理由见本次讨论，等真有需求再说。
- 分叉不支持"分叉到父会话的某个中间点"（对应 pi-durable 的 `fork(entryId)`）：先只支持从父会话当前的末尾分叉，需求明确后再加。

## 审查和发布

照例：实现前请灵算 astra 看这份设计里的未决点（会话 header、跨 provider 的思考块）；实现后请 Pi 的 Codex 6.1 sol 审查；先写会失败的测试，修完做变异检查。版本号按补丁号递增。
