import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A delegate that keeps calling tools gets its last turn without tools, so it ends with an answer
// instead of being aborted at the turn limit with nothing to show.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-final-turn-"));
const requests = [];
let requestNo = 0;
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  requestNo++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "final", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  // A model that never stops exploring while it has tools.
  if (request.tools?.length) {
    const name = request.tools[0].function.name;
    emit({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requestNo}`, type: "function",
      function: { name, arguments: JSON.stringify(name === "ls" ? { path: dir } : { message: "probe" }) } }] });
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
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { direct: {
    command: process.execPath, args: [fileURLToPath(new URL("./native-mcp.mjs", import.meta.url)), "fixture", "direct"],
    exposure: "direct",
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    { id: "think", name: "think", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh" }, input: ["text"],
      contextWindow: 16000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_ALLOW_TOOLS: "mcp__direct__echo" } }));
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

  // maxToolCalls: the model is told its exact count at 75%, and loses its tools at the cap, however
  // many turns remain; a follow_up after the cap is answer-only too.
  requests.length = 0;
  await call("spawn", { cwd: dir, id: "capped", prompt: "explore", tools: ["ls"], maxTurns: 20, maxToolCalls: 4 });
  const capped = await settle("capped");
  assert.equal(capped.state, "done", JSON.stringify(capped.termination));
  assert.equal(capped.toolCallCount, 4);
  assert.equal(capped.lastText, "SUMMARY from what I read");
  assert.equal(capped.limits.maxToolCalls, 4);
  assert.ok(!requests.at(-1).tools?.length, "the turn after the cap has no tools");
  const told = requests.find((r) => JSON.stringify(r.messages).includes("You have used 3 of 4 tool calls"));
  assert.ok(told, "the model is told how many calls it has used");
  requests.length = 0;
  await call("follow_up", { sessionId: "capped", prompt: "more" });
  await settle("capped");
  assert.ok(requests.every((r) => !r.tools?.length), "no tools after the cap, also on follow_up");
  const beforeCallRenewal = await call("status", { sessionId: "capped" });
  requests.length = 0;
  await call("follow_up", { sessionId: "capped", prompt: "two more checks", maxToolCalls: 2 });
  const afterCallRenewal = await settle("capped");
  assert.equal(afterCallRenewal.turns, beforeCallRenewal.turns + 3);
  assert.equal(afterCallRenewal.toolCallCount, 6);
  assert.equal(afterCallRenewal.limits.maxTurns, 20);
  assert.deepEqual(afterCallRenewal.budgetStart, { turns: 0, toolCalls: 4 }, "call-only renewal preserves the turn boundary");
  assert.equal(requests.filter(r => r.tools?.length).length, 2);

  // Explicit renewal grants only this run fresh quotas; ordinary follow_up remains cumulative.
  for (const durable of [false, true]) {
    const id = `renew-${durable}`;
    await call("spawn", { cwd: dir, id, prompt: "explore", tools: ["ls"], maxTurns: 3, maxToolCalls: 2, durable });
    const before = await settle(id);
    assert.equal(before.remainingTurns, 0);
    const refused = await client.callTool({ name: "follow_up", arguments: { sessionId: id, prompt: "again" } });
    assert.ok(refused.isError, "no implicit renewal");
    requests.length = 0;
    await call("follow_up", { sessionId: id, prompt: "explore again", maxTurns: 4, maxToolCalls: 2 });
    const after = await settle(id);
    assert.equal(after.state, "done");
    assert.equal(after.turns, 6, "turn count remains cumulative");
    assert.equal(after.toolCallCount, 4, "tool trace remains cumulative");
    assert.equal(after.remainingTurns, 1);
    assert.equal(after.limits.maxTurns, 4, "limits describe the renewed quota, not a cumulative boundary");
    assert.deepEqual(after.budgetStart, { turns: 3, toolCalls: 2 });
    assert.equal(after.usage.input, before.usage.input + 300);
    assert.equal(requests.filter(r => r.tools?.length).length, 2, "previously removed tools return with fresh quotas");
    assert.ok(requests[0].messages.some(m => JSON.stringify(m).includes("SUMMARY from what I read")), "history is retained");
    await call("follow_up", { sessionId: id, prompt: "plain follow-up" });
    assert.equal((await settle(id)).turns, 7);
    const toolOnly = await client.callTool({ name: "follow_up", arguments: { sessionId: id, prompt: "again", maxToolCalls: 2 } });
    assert.ok(toolOnly.isError, "renewing calls does not renew exhausted turns");
    requests.length = 0;
    await call("follow_up", { sessionId: id, prompt: "answer only", maxTurns: 2 });
    const turnOnly = await settle(id);
    assert.equal(turnOnly.toolCallCount, 4, "renewing turns does not renew exhausted calls");
    assert.ok(requests.every(r => !r.tools?.length));
  }

  // With one turn in total, that turn is the last one.
  requests.length = 0;
  await call("spawn", { cwd: dir, id: "single", prompt: "explore", tools: ["ls"], maxTurns: 1 });
  const single = await settle("single");
  assert.deepEqual([single.state, single.lastText], ["done", "SUMMARY from what I read"]);
  // Native MCP tools register while the first prompt starts, after track() removed its tools.
  for (const durable of [false, true]) {
    for (const maxTurns of [1, 3]) {
      requests.length = 0;
      const id = `native-${durable}-${maxTurns}`;
      await call("spawn", { cwd: dir, id, prompt: "explore", tools: ["mcp__direct__echo"],
        nativeMcp: true, mcpServers: ["direct"], maxTurns, durable });
      const snap = await settle(id);
      assert.deepEqual([snap.state, snap.lastText, snap.turns], ["done", "SUMMARY from what I read", maxTurns]);
      assert.equal(snap.toolCalls.length, maxTurns - 1, "no native calls during the answer turn");
      assert.ok(!requests.at(-1).tools?.length, "native tools stay absent from the answer request");
      assert.deepEqual(snap.activeTools, []);
      requests.length = 0;
      await call("follow_up", { sessionId: id, prompt: "explore again", maxTurns: 3, maxToolCalls: 1 });
      const renewed = await settle(id);
      assert.equal(renewed.state, "done");
      assert.equal(renewed.turns, maxTurns + 2);
      assert.equal(renewed.toolCallCount, maxTurns);
      assert.deepEqual(requests[0].tools.map(t => t.function.name), ["mcp__direct__echo"], "renewal reactivates only the original native grant");
      assert.ok(!requests.at(-1).tools?.length);
      assert.deepEqual(renewed.activeTools, []);
    }
  }
  console.log("  OK -> the last turn has no tools, so a delegate that keeps exploring still answers");
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
