import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A slow, high-effort model can spend the rest of a run on its closing request. Opt-in: once the run
// is asked to wrap up, it continues at a lower thinking level; the next run starts at its own again.
const { finishThinkingFor } = await import("../dist/pi/models.js");
assert.equal(finishThinkingFor(["medium"], "openai-codex/gpt-6.1-sol"), "medium", "a bare level applies to every model");
assert.equal(finishThinkingFor(["xai/*:low", "high"], "xai/grok-4.7"), "low", "the first matching entry applies");
assert.equal(finishThinkingFor(["xai/*:low"], "openai-codex/gpt-6.1-sol"), undefined);
assert.equal(finishThinkingFor(["xai/*"], "xai/grok-4.7"), undefined, "an entry without a level sets nothing");

const dir = await mkdtemp(join(tmpdir(), "pi-delegate-finish-thinking-"));
const efforts = [];
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const followUp = request.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("AGAIN"));
  const results = request.messages.filter((m) => m.role === "tool").length;
  efforts.push(request.reasoning_effort);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk",
    created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  // Keeps calling ls until its tools are gone; a follow-up is answered at once.
  if (!followUp && results < 7) {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: `call_${results}`, type: "function",
      function: { name: "ls", arguments: JSON.stringify({ path: dir }) } }] });
    emit({}, "tool_calls");
  } else {
    emit({ role: "assistant", content: "ANSWER" });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const clients = [];
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "deep", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "deep", name: "deep", reasoning: true, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const connect = async (env) => {
    const client = new Client({ name: "finish-thinking", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
      env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
        PI_DELEGATE_MODEL: "test/deep", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0", ...env } }));
    clients.push(client);
    return client;
  };
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  // maxTurns 8: wrap-up is asked for after turn 6, and the tools go after turn 7.
  const run = (client) => call(client, "run", { cwd: dir, prompt: "list", tools: ["ls"], thinking: "high", maxTurns: 8, verbose: true });

  const plain = await run(await connect({}));
  assert.equal(plain.lastText, "ANSWER");
  assert.deepEqual(efforts, Array(8).fill("high"), "unchanged unless the server opts in");

  // Entries name models; one that matches none leaves the run unchanged.
  efforts.length = 0;
  await run(await connect({ PI_DELEGATE_FINISH_THINKING: "other/*:low" }));
  assert.deepEqual(efforts, Array(8).fill("high"));

  efforts.length = 0;
  const client = await connect({ PI_DELEGATE_FINISH_THINKING: "other/*:low,test/*:medium" });
  const lowered = await run(client);
  assert.equal(lowered.lastText, "ANSWER");
  assert.deepEqual(efforts, [...Array(6).fill("high"), "medium", "medium"]);
  assert.equal(lowered.thinking, "high", "the run's own level is still reported");
  assert.equal(lowered.notices.filter((n) => /thinking high -> medium/.test(n.message)).length, 1);

  efforts.length = 0;
  await call(client, "follow_up", { sessionId: lowered.sessionId, prompt: "AGAIN", maxTurns: 2 });
  await call(client, "wait", { sessionId: lowered.sessionId, until: "settled" });
  assert.deepEqual(efforts, ["high"], "a follow-up starts at the run's own level again");
  console.log("  OK -> with PI_DELEGATE_FINISH_THINKING, a run asked to wrap up continues at that lower thinking level; follow-ups start at their own");
} finally {
  for (const c of clients) await c.close().catch(() => {});
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
