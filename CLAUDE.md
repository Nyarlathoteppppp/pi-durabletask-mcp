# 开发交接：0.3.2（2026-10-04）

## 本轮结论

优先降低 Claude/Codex 的操作成本。收益最高的是取消强制 `init`，并用短指令说明已有工作流。

- 工具直接可用；`init` 只做可选配置/认证诊断。任务启动时的权限和认证检查保留。
- Pi SDK 自选的默认模型也走现有 allowlist、denylist、项目 scope 校验，在请求模型前拒绝违规选择。
- `wait` 遇到 pending question 提前返回；取消等待不停止 worker。取消 `run` 会停止其 worker。
- 已补工具 annotations、精简 server instructions 和使用说明；作者本机 Codex/Claude 共用的 `pi-coding-agent` skill 已同步。
- 本轮不增加执行能力，不改 durability、ownership、recovery、retention 或 SQLite 布局。`nextAction`、structured output、MCP Tasks 暂不做。

## 验证与审查

- `npm test`：23 组全部通过，包含真实 Pi SDK 的离线假 provider 测试。
- antigravity/gemini-3.8-flash 与 xai/grok-4.7：补审正在进行；第一轮因轮次预算未读完关键代码，不能计作审查通过。

## 接手注意

- 正在运行的 MCP host 不会热加载新代码/工具描述；需重连或新开客户端会话。
- stdio 入口在连接前恢复任务；嵌入 `createServer()` 的调用者负责启动恢复，`init` 不再触发恢复。
- 内存会话在当前 host 保留期间也能 `follow_up`；跨重启或需盘上历史才用 `durable: true`。轮次预算始终累计。
- 按当前 diff 和测试结果继续；不因理论极限新增门禁、回退或压力场景防御。
