import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The fake model replies with the first user message, so each result shows the prompt its task ran.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-batch-prompt-"));
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const user = request.messages.find((m) => m.role === "user");
  const text = typeof user.content === "string" ? user.content : user.content.map((p) => p.text ?? "").join("");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "echo", object: "chat.completion.chunk", created: 1, model: request.model,
    choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  emit({ role: "assistant", content: text });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "batch-prompt", version: "1" });
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0", PI_DELEGATE_ALLOW_TOOLS: "codemode" } }));
  const raw = (name, args) => client.callTool({ name, arguments: args });
  const call = async (name, args) => {
    const result = await raw(name, args);
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const texts = async (batch) => {
    const result = await call("wait", { sessionIds: batch.sessionIds, until: "all_settled", timeoutMs: 15000 });
    assert.deepEqual(result.pending, []);
    return Object.fromEntries(result.sessions.map((s) => [s.label, s.lastText]));
  };

  // One prompt sent to several tasks, e.g. one review across models; a task's own prompt wins.
  const shared = await call("spawn_batch", { cwd: dir, tools: [], prompt: "BATCH-PROMPT",
    tasks: [{ label: "inherits" }, { label: "own", prompt: "OWN-PROMPT" }] });
  assert.deepEqual(await texts(shared), { inherits: "BATCH-PROMPT", own: "OWN-PROMPT" });

  // A coordinator task keeps its default synthesis prompt rather than the batch prompt.
  const team = await call("spawn_batch", { cwd: dir, prompt: "BATCH-PROMPT",
    tasks: [{ label: "coordinator", coordinator: { tasks: [{ prompt: "child" }] } }] });
  const { coordinator } = await texts(team);
  assert.match(coordinator, /^Coordinate the caller's approved task plan/);
  assert.doesNotMatch(coordinator, /BATCH-PROMPT/);

  // With no prompt anywhere an ordinary task is still refused, and nothing starts.
  const refused = await raw("spawn_batch", { cwd: dir, tools: [], tasks: [{ label: "a", prompt: "x" }, { label: "b" }] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /prompt is required/);
  console.log("  OK -> spawn_batch prompt is the default for ordinary tasks; task prompts and coordinator defaults win");
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
