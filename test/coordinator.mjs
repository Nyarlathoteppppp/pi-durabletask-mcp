import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = await mkdtemp(join(tmpdir(), "pi-coordinator-"));
const sockets = new Set();
const inherited = [];
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const users = request.messages.filter((m) => m.role === "user");
  const prompt = JSON.stringify(users.at(-1).content);
  if (prompt.includes("FAIL_CHILD")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "intentional child failure" } })); return;
  }
  if (prompt.includes("SLOW_CHILD")) return; // held until this child's ordinary abort
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "coord", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const tool = (name, args) => {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: `call-${request.messages.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    emit({}, "tool_calls");
  };
  const answer = (content) => { emit({ role: "assistant", content }); emit({}, "stop"); };
  const scripts = request.messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []).filter((c) => c.function.name === "codemode").length;
  if (prompt.includes("COORDINATOR")) {
    assert.ok(request.tools.every((t) => !t.function.name.startsWith("delegate_")), "child tools are script-only, not direct declarations");
    if (!scripts) tool("codemode", { code: 'try { await tools.delegate_get({ sessionId: "facts" }); return "BAD foreign read"; } catch(e) { const b = await tools.delegate_start_batch({}); store("batch", b); return {blocked: e.message, batch:b}; }' });
    else if (scripts === 1) tool("codemode", { code: 'const b=load("batch"); const w=await tools.delegate_wait({sessionIds:b.sessionIds,timeoutMs:1000}); const reports=await Promise.all(b.sessionIds.map(sessionId=>tools.delegate_get({sessionId}))); store("reports",reports); return {states:reports.map(r=>({id:r.sessionId,state:r.state,error:r.error})),wait:w};' });
    else if (scripts === 2) tool("codemode", { code: 'const reports=load("reports"); const repeated=await tools.delegate_start_batch({}); return { reports, repeated };' });
    else answer(`FINAL ${JSON.stringify(request.messages.at(-1).content)}`);
  } else if (prompt.includes("OVERFLOW")) {
    if (!scripts) tool("codemode", { code: 'try {return await tools.delegate_start_batch({});} catch(e) {return e.message;}' });
    else answer(JSON.stringify(request.messages.at(-1).content));
  } else if (prompt.includes("CANCEL_PARENT")) {
    if (!scripts) tool("codemode", { code: 'const b=await tools.delegate_start_batch({}); store("batch",b); return b;' });
    else tool("codemode", { code: 'return await tools.delegate_wait({timeoutMs:55000});' });
  } else if (prompt.includes("CHILD")) {
    inherited.push(request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("ALPHA")));
    answer("CHILD REPORT ALPHA " + "evidence ".repeat(230));
  } else if (prompt.includes("NO_COORD")) {
    if (!scripts) tool("codemode", { code: 'try {return await tools.delegate_start_batch({});} catch(e) {return "UNAVAILABLE " + e.message;}' });
    else answer(JSON.stringify(request.messages.at(-1).content));
  } else if (request.messages.at(-1).role !== "tool") tool("read", { path: "a.txt" });
  else answer("FACTS ALPHA");
  res.end("data: [DONE]\n\n");
});
http.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const client = new Client({ name: "coordinator", version: "1" });
try {
  const agentDir = join(dir, "agent"); await mkdir(agentDir);
  await writeFile(join(dir, "a.txt"), "ALPHA\n");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore", env: {
    ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
    PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_ALLOW_TOOLS: "codemode,write", PI_DELEGATE_MAX_CONCURRENT: "4",
  } }));
  const raw = (name, args) => client.callTool({ name, arguments: args });
  const call = async (name, args) => { const r = await raw(name, args); assert.ok(!r.isError, r.content[0].text); return JSON.parse(r.content[0].text); };
  const settle = async (id) => { let r; do r = await call("wait", { sessionId: id, until: "settled", timeoutMs: 15000 }); while (r.nextAction === "wait"); return r; };
  await call("spawn", { cwd: dir, id: "facts", prompt: "FACT", tools: ["read"], maxTurns: 3 });
  await settle("facts");
  const coordinator = { forkFrom: "facts", saveDir: join(dir, "reports"), tasks: [
    { prompt: "CHILD_A", label: "a", tools: [], maxTurns: 2 },
    { prompt: "FAIL_CHILD", label: "failure", tools: [], maxTurns: 2 },
  ] };
  await call("spawn", { cwd: dir, id: "boss", prompt: "COORDINATOR", tools: ["codemode"], coordinator, maxTurns: 6 });
  const boss = await settle("boss");
  assert.equal(boss.state, "done", boss.error);
  assert.match(boss.lastText, /CHILD REPORT ALPHA/);
  const full = await call("status", { sessionId: "boss", verbose: true });
  const started = full.toolCalls.find((t) => t.name === "delegate_start_batch");
  assert.equal(started.state, "ok", JSON.stringify(started));
  const batch = JSON.parse(started.result);
  assert.equal(batch.sessionIds.length, 2);
  assert.deepEqual(batch.sessions.map((s) => s.taskIndex), [0, 1]);
  for (const id of batch.sessionIds) {
    const state = await call("status", { sessionId: id, verbose: true });
    assert.deepEqual(state.activeTools, []);
    assert.equal(state.durable, false);
    assert.equal(state.toolCallCount, 0);
    assert.equal(state.forkedFrom, "facts");
    assert.equal(state.turns, 1, "fork budgets start fresh");
    if (state.label === "a") {
      assert.equal(state.state, "done");
      assert.match(await readFile(state.savedTo, "utf8"), /CHILD REPORT ALPHA/);
    } else { assert.equal(state.state, "error"); assert.match(state.error, /intentional child failure/); }
  }
  assert.deepEqual(inherited, [true], "child reuses inherited evidence without re-reading it");
  const waiting = full.toolCalls.find((t) => t.name === "delegate_wait");
  assert.equal(waiting.state, "ok");
  assert.doesNotMatch(waiting.result, /lastText/, "waiting avoids reprinting reports");
  assert.match(boss.lastText, /intentional child failure/, "a failed child stays visible");
  assert.equal(full.toolCalls.filter((t) => t.name === "delegate_start_batch").length, 2);
  assert.equal((await call("sessions", {})).sessions.filter((s) => ["a", "failure"].includes(s.label)).length, 2, "repeat default dispatch does not duplicate children");

  for (const args of [
    { durable: true, tools: ["codemode"], coordinator },
    { tools: ["read"], coordinator },
    { tools: ["codemode"], coordinator: { tasks: [{ prompt: "x", tools: ["write"] }] } },
    { tools: ["codemode"], coordinator: { tasks: [{ prompt: "x", coordinator }] } },
  ]) assert.equal((await raw("spawn", { cwd: dir, prompt: "x", ...args })).isError, true);
  await call("spawn", { cwd: dir, id: "plain", prompt: "NO_COORD", tools: ["codemode"], maxTurns: 3 });
  assert.match((await settle("plain")).lastText, /UNAVAILABLE/);
  await call("spawn", { cwd: dir, id: "overflow", prompt: "OVERFLOW", tools: ["codemode"], maxTurns: 3,
    coordinator: { tasks: Array.from({ length: 4 }, () => ({ prompt: "CHILD", tools: [] })) } });
  assert.match((await settle("overflow")).lastText, /concurrent/i, "coordinator occupies the fourth slot");
  assert.equal((await call("sessions", {})).sessions.filter((s) => ["a", "failure"].includes(s.label)).length, 2);

  await call("spawn", { cwd: dir, id: "cancel-boss", prompt: "CANCEL_PARENT", tools: ["codemode"], maxTurns: 5,
    coordinator: { tasks: [{ prompt: "SLOW_CHILD", label: "slow", tools: [], maxDurationMs: 60000 }] } });
  let slow;
  for (let n = 0; n < 100; n++) {
    slow = (await call("sessions", {})).sessions.find((s) => s.label === "slow");
    if (slow?.state === "running") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(slow.state, "running");
  await call("abort", { sessionId: "cancel-boss" });
  assert.equal((await call("status", { sessionId: slow.sessionId })).state, "running", "cancellation is observational, not cascading");
  await call("abort", { sessionId: slow.sessionId });
  console.log("  OK -> codemode coordinator: shared core state, fork evidence, compact waits/full stored reports, failures, capacity and cancellation");
} finally {
  await client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => http.close(r));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
