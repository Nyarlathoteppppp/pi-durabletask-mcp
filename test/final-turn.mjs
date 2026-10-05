import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A delegate that keeps calling tools gets its last turn without tools, so it ends with an answer
// instead of being aborted at the turn limit with nothing to show.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-final-turn-"));
const requests = [];
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "final", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  // A model that never stops exploring while it has tools.
  if (request.tools?.length) {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function",
      function: { name: "ls", arguments: JSON.stringify({ path: dir }) } }] });
    emit({}, "tool_calls");
  } else {
    emit({ role: "assistant", content: "SUMMARY from what I read" });
    emit({}, "stop");
  }
  // Each request reports its usage, as providers do with stream_options.include_usage.
  res.write(`data: ${JSON.stringify({ id: "final", object: "chat.completion.chunk", created: 1, model: request.model, choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "final-turn", version: "1" });
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    { id: "think", name: "think", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh" }, input: ["text"],
      contextWindow: 16000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1" } }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const settle = async (id) => {
    let snap;
    do snap = await call("wait", { sessionId: id, until: "settled", timeoutMs: 15000 }); while (snap.nextAction === "wait");
    return call("status", { sessionId: id, verbose: true });
  };

  for (const durable of [false, true]) {
    requests.length = 0;
    const id = `looping-${durable}`;
    await call("spawn", { cwd: dir, id, prompt: "explore", tools: ["ls"], maxTurns: 4, durable });
    const snap = await settle(id);
    assert.equal(snap.state, "done", `durable=${durable}: answered, not aborted (${JSON.stringify(snap.termination)})`);
    assert.equal(snap.lastText, "SUMMARY from what I read");
    assert.equal(snap.turns, 4);
    assert.ok(requests.slice(0, -1).every((r) => r.tools?.length), "tools until the last turn");
    assert.ok(!requests.at(-1).tools?.length, "the last turn has no tools");
    // What the session cost, summed over its requests, in status and in the finished wait result.
    assert.equal(snap.usage?.input, 100 * requests.length);
    assert.equal(snap.usage.output, 10 * requests.length);
    assert.ok(snap.usage.cost > 0);
    const waited = await call("wait", { sessionId: id, until: "settled", timeoutMs: 1000 });
    assert.deepEqual(waited.usage, snap.usage);
  }

  // models says which thinking levels a model accepts, and a wrong one is refused with that list.
  const listed = await call("models", { filter: "test/" });
  assert.deepEqual(listed.thinkingLevels, { "test/think": ["off", "low", "medium", "high", "xhigh"] });
  const refused = await client.callTool({ name: "spawn", arguments: { cwd: dir, prompt: "x", model: "test/think", thinking: "max" } });
  assert.ok(refused.isError);
  assert.match(refused.content[0].text, /does not support thinking: max; it supports: off, low, medium, high, xhigh/);

  // With one turn in total, that turn is the last one.
  requests.length = 0;
  await call("spawn", { cwd: dir, id: "single", prompt: "explore", tools: ["ls"], maxTurns: 1 });
  const single = await settle("single");
  assert.deepEqual([single.state, single.lastText], ["done", "SUMMARY from what I read"]);
  console.log("  OK -> the last turn has no tools, so a delegate that keeps exploring still answers");
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
