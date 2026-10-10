import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Some models still call a tool on the last turn, after their tools were removed. That call fails
// without effect; the run gets one more tool-free turn to answer instead of ending with nothing.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-answer-grace-"));
const requests = {};
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const prompt = JSON.stringify(request.messages.find((m) => m.role === "user")?.content);
  const results = request.messages.filter((m) => m.role === "tool").length;
  const kind = prompt.includes("HOPELESS") ? "hopeless" : "stubborn";
  requests[kind] = (requests[kind] ?? 0) + 1;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "g", object: "chat.completion.chunk",
    created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  // Calls ls whether or not it is offered: twice when STUBBORN, always when HOPELESS.
  if (prompt.includes("HOPELESS") || results < 2) {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: `call_${results}`, type: "function",
      function: { name: "ls", arguments: JSON.stringify({ path: dir }) } }] });
    emit({}, "tool_calls");
  } else {
    emit({ role: "assistant", content: "FINAL ANSWER" });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const clients = [];
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const connect = async (env) => {
    const client = new Client({ name: "answer-grace", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
      env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
        PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0", ...env } }));
    clients.push(client);
    return client;
  };
  let client = await connect({});
  const run = async (prompt) => {
    const result = await client.callTool({ name: "run", arguments: { cwd: dir, prompt, tools: ["ls"], maxTurns: 2, verbose: true } });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const grace = (r) => r.notices.filter((n) => /answer-only grace turn/.test(n.message));

  // Off unless the server opts in: the run ends at max_turns as before.
  const plain = await run("STUBBORN");
  assert.equal(plain.state, "aborted");
  assert.equal(plain.turns, 2, "a turn the abort cut off before it began is not counted");
  assert.equal(grace(plain).length, 0);
  delete requests.stubborn;

  client = await connect({ PI_DELEGATE_ANSWER_GRACE: "1" });
  const stubborn = await run("STUBBORN");
  assert.equal(stubborn.state, "done", JSON.stringify(stubborn.termination ?? stubborn.error ?? null));
  assert.equal(stubborn.lastText, "FINAL ANSWER");
  assert.equal(requests.stubborn, 3, "one model request past the budget, no more");
  assert.equal(grace(stubborn).length, 1);

  const hopeless = await run("HOPELESS");
  assert.equal(hopeless.state, "aborted");
  assert.equal(hopeless.termination.reason, "max_turns");
  assert.equal(requests.hopeless, 3, "the grace turn is given once");
  assert.equal(hopeless.turns, 3);
  assert.equal(grace(hopeless).length, 1);
  console.log("  OK -> a tool call after the tools were removed gets one answer-only grace turn, once per run, when the server opts in");
} finally {
  for (const c of clients) await c.close().catch(() => {});
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
