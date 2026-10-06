import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-delegate-fork-")));
const clients = new Set(), sockets = new Set(), requests = [];
const content = "FORK_FIXTURE_4271";
const fixture = join(dir, "fixture.txt");
const lastUser = (request) => JSON.stringify(request.messages.findLast((m) => m.role === "user")?.content);
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  const prompt = lastUser(request);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (prompt.includes("HOLD") && !prompt.includes("The MCP service restarted.")) return;
  const emit = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({
    id: "fork-fixture", object: "chat.completion.chunk", created: 1, model: request.model,
    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
  })}\n\n`);
  if (prompt.includes("WRITE_PARENT") && !request.messages.some((m) => m.role === "tool")) {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: "parent-write", type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: join(dir, "written.txt"), content: "parent wrote this" }) } }] });
    emit({}, "tool_calls");
  } else if (prompt.includes("READ_PARENT") && !request.messages.some((m) => m.role === "tool")) {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: "parent-read", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: fixture }) } }] });
    emit({}, "tool_calls");
  } else {
    emit({ role: "assistant", content: `Answer for ${prompt}` });
    emit({}, "stop");
  }
  emit({}, null, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const agentDir = join(dir, "agent");
await mkdir(agentDir);
await writeFile(fixture, content);
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
  baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
  models: ["one", "two"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 32000,
    maxTokens: 1024, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })),
} } }));
const open = async () => {
  const client = new Client({ name: "fork", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore", env: {
    ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
    PI_DELEGATE_ALLOW_TOOLS: "write", PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0",
  } });
  await client.connect(transport);
  clients.add(client);
  const raw = (name, args) => client.callTool({ name, arguments: args });
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const settle = (id) => call("wait", { sessionId: id, until: "settled", timeoutMs: 15000, verbose: true });
  const refused = async (args, pattern, name = "spawn") => {
    const result = await raw(name, args);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, pattern);
  };
  return { client, transport, call, settle, refused };
};
const until = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fork fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const requestFor = (marker) => requests.findLast((r) => lastUser(r).includes(marker));
try {
  let host = await open();
  await host.call("spawn", { cwd: dir, id: "parent", prompt: "READ_PARENT", tools: ["read"], maxTurns: 8, maxToolCalls: 5 });
  const parent = await host.settle("parent");
  assert.equal(parent.state, "done");
  assert.equal(parent.turns, 2);
  assert.equal(parent.toolCallCount, 1);
  assert.equal(parent.usage.totalTokens, 240);
  await host.call("spawn", { cwd: dir, id: "writing-parent", prompt: "WRITE_PARENT", tools: ["write"], maxTurns: 5 });
  const writingParent = await host.settle("writing-parent");
  assert.deepEqual(writingParent.touchedFiles, [join(dir, "written.txt")]);
  assert.equal(writingParent.editWriteCount, 1);
  await host.call("spawn", { forkFrom: "writing-parent", id: "readonly-child", prompt: "No edits; just summarize.", tools: [] });
  const readonlyChild = await host.settle("readonly-child");
  assert.equal(readonlyChild.forkedFrom, "writing-parent");
  assert.equal(readonlyChild.touchedFiles, undefined, "fork transcript does not import the parent's writes");
  assert.equal(readonlyChild.editWriteCount, undefined);

  const batch = await host.call("spawn_batch", { forkFrom: "parent", idPrefix: "fork", maxTurns: 4,
    tasks: [{ prompt: "ALPHA" }, { prompt: "BETA", model: "test/two", tools: [] }] });
  const [alphaId, betaId] = batch.sessions.map((s) => s.sessionId);
  const [alpha, beta] = await Promise.all([host.settle(alphaId), host.settle(betaId)]);
  const summaries = await host.call("wait", { sessionIds: ["parent", alphaId, betaId], until: "all_settled" });
  assert.ok(!Object.hasOwn(summaries.sessions[0], "forkedFrom"), "ordinary sessions omit fork provenance");
  assert.deepEqual(summaries.sessions.slice(1).map((s) => s.forkedFrom), ["parent", "parent"]);
  for (const child of [alpha, beta]) {
    assert.equal(child.state, "done");
    assert.equal(child.forkedFrom, "parent");
    assert.equal(child.cwd, dir);
    assert.equal(child.turns, 1);
    assert.equal(child.toolCallCount, 0);
    assert.equal(child.usage.totalTokens, 120);
    assert.equal(child.limits.maxToolCalls, undefined, "parent tool budget is not inherited");
  }
  assert.deepEqual([alpha.model, beta.model], ["test/one", "test/two"]);
  assert.deepEqual([alpha.activeTools, beta.activeTools], [["read"], []]);
  for (const [own, sibling] of [["ALPHA", "BETA"], ["BETA", "ALPHA"]]) {
    const transcript = JSON.stringify(requestFor(own).messages);
    assert.ok(transcript.includes(content));
    assert.ok(transcript.includes("READ_PARENT"));
    assert.ok(!transcript.includes(sibling));
  }
  await host.call("follow_up", { sessionId: "parent", prompt: "PARENT_ONLY" });
  await host.settle("parent");
  await host.call("follow_up", { sessionId: alphaId, prompt: "CHILD_ONLY" });
  const followed = await host.settle(alphaId);
  assert.equal(followed.usage.totalTokens, 240);
  assert.ok(!JSON.stringify(requestFor("CHILD_ONLY").messages).includes("PARENT_ONLY"));
  assert.ok(!JSON.stringify(requestFor("PARENT_ONLY").messages).includes("ALPHA"));
  // Forking a fork deducts the complete inherited history, not just the parent's own bill.
  const grandchild = await host.call("run", { forkFrom: alphaId, prompt: "GRANDCHILD", tools: [] });
  assert.deepEqual([grandchild.forkedFrom, grandchild.turns, grandchild.usage.totalTokens], [alphaId, 1, 120]);
  assert.ok((await host.call("sessions")).sessions.some((s) => s.sessionId === alphaId && s.forkedFrom === "parent"));
  const overrideCwd = join(dir, "override");
  await mkdir(overrideCwd);
  const override = await host.call("run", { forkFrom: "parent", cwd: overrideCwd,
    prompt: "OVERRIDE", tools: [], model: "test/two", maxTurns: 1, verbose: true });
  assert.deepEqual([override.cwd, override.model, override.activeTools], [overrideCwd, "test/two", []]);

  const before = requests.length;
  await host.refused({ forkFrom: "parent", idPrefix: "bad", tasks: [{ prompt: "NO_START" }, { prompt: "NO_START", tools: ["bash"] }] }, /tool|permitted|allow/i, "spawn_batch");
  assert.equal(requests.length, before, "batch policy failure starts no sibling");
  await host.refused({ forkFrom: "missing", prompt: "no" }, /Unknown sessionId/);
  await host.call("spawn", { cwd: dir, id: "busy", prompt: "HOLD_BUSY", tools: [] });
  await until(() => requestFor("HOLD_BUSY"));
  await host.refused({ forkFrom: "busy", prompt: "no" }, /active|settle/);
  await host.call("abort", { sessionId: "busy" });
  await host.settle("busy");

  await host.call("run", { cwd: dir, id: "disk-parent", prompt: "DISK_PARENT", tools: [], durable: true });
  const other = await open();
  await other.refused({ forkFrom: "disk-parent", prompt: "no" }, /another MCP process/);
  await other.client.close(); clients.delete(other.client);
  // One crash while a durable branch is in flight: its parent is memory-only and disappears.
  await host.call("spawn", { forkFrom: "parent", id: "disk-child", prompt: "HOLD_DURABLE", tools: [], durable: true, maxTurns: 8 });
  await until(() => requestFor("HOLD_DURABLE"));
  process.kill(host.transport.pid, "SIGKILL");
  await host.client.close(); clients.delete(host.client);
  host = await open();
  const recovered = await host.settle("disk-child");
  assert.equal(recovered.state, "done");
  assert.equal(recovered.forkedFrom, "parent");
  const resumed = requests.findLast((r) => lastUser(r).includes("The MCP service restarted."));
  assert.ok(JSON.stringify(resumed.messages).includes(content));
  assert.ok(JSON.stringify(resumed.messages).includes("PARENT_ONLY"));
  assert.equal(recovered.usage.totalTokens, 120);
  await host.call("follow_up", { sessionId: "disk-child", prompt: "AFTER_RECOVERY" });
  assert.equal((await host.settle("disk-child")).usage.totalTokens, 240);
  const observer = await open();
  assert.ok((await observer.call("sessions")).stored.some((s) => s.sessionId === "disk-child" && s.forkedFrom === "parent"));
  await observer.client.close(); clients.delete(observer.client);
  // Lazy-load a finished parent after restart, and inherit its recorded configuration.
  const lazy = await host.call("run", { forkFrom: "disk-parent", prompt: "LAZY_FORK", verbose: true });
  assert.equal(lazy.forkedFrom, "disk-parent");
  assert.equal(lazy.durable, false, "children of durable parents still default to memory");
  assert.ok(JSON.stringify(requestFor("LAZY_FORK").messages).includes("DISK_PARENT"));
  console.log("  OK -> forks share settled history but isolate runs, siblings and usage; inheritance/overrides, policy, ownership, lazy-load and durable recovery");
} finally {
  await Promise.allSettled([...clients].map((client) => client.close()));
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
