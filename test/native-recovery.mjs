import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = await mkdtemp(join(tmpdir(), "pi-native-recovery-"));
const agent = join(dir, "agent");
const state = join(dir, "state");
const requests = [];
const hosts = new Set();
const sockets = new Set();
const until = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Native recovery fixture timed out");
    await new Promise(r => setTimeout(r, 20));
  }
};
const contents = async (path) => { try { return await readFile(path, "utf8"); } catch { return ""; } };
const http = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); requests.push(request);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "native-test", object: "chat.completion.chunk", created: 1, model: "one", choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  const user = JSON.stringify(request.messages.findLast(m => m.role === "user")?.content);
  if (user.includes("The MCP service restarted.") && !request.messages.some(m => m.role === "tool" && JSON.stringify(m.content).includes("RECONNECTED"))) {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: "reconnect-script", type: "function",
      function: { name: "codemode", arguments: JSON.stringify({ code: 'text(await tools.mcp__fixture__echo({text:"RECONNECTED"}));' }) } }] });
    emit({}, "tool_calls");
  } else if (user.includes("The MCP service restarted.") || request.messages.at(-1).role === "tool") {
    emit({ role: "assistant", content: "NATIVE_RECOVERED" }); emit({}, "stop");
  } else {
    const code = user.includes("BARRIER")
      ? 'text(await tools.mcp__fixture__effect({mode:"barrier"}));'
      : 'await Promise.all([tools.mcp__fixture__effect({mode:"completed"}), tools.mcp__fixture__effect({mode:"unknown"})]);';
    emit({ role: "assistant", tool_calls: [{ index: 0, id: "outer-script", type: "function",
      function: { name: "codemode", arguments: JSON.stringify({ code }) } }] });
    emit({}, "tool_calls");
  }
  res.end("data: [DONE]\n\n");
});
http.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise(r => http.listen(0, "127.0.0.1", r));
const connect = async (hooks = {}) => {
  const client = new Client({ name: "native-recovery", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["test/recovery-server.mjs"],
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agent, PI_DELEGATE_STATE_DIR: state,
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_ALLOW_WRITE: "0",
      PI_DELEGATE_ALLOW_TOOLS: "codemode,mcp__fixture__effect,mcp__fixture__echo", ...hooks } });
  const host = { client, transport }; hosts.add(host);
  await client.connect(transport);
  host.call = async (name, args = {}) => {
    // These tests exercise durability, which is opt-in for new delegates.
    if ((name === "spawn" || name === "run") && args.durable === undefined) args = { ...args, durable: true };
    const reply = await client.callTool({ name, arguments: args }); assert.ok(!reply.isError, reply.content[0]?.text);
    return JSON.parse(reply.content[0].text);
  };
  await host.call("init", { cwd: dir }); return host;
};
const spawn = (host, id, prompt) => host.call("spawn", { id, cwd: dir, prompt, nativeMcp: true,
  mcpServers: ["fixture"], extensions: false, tools: ["codemode", "mcp__fixture__effect", "mcp__fixture__echo"], maxTurns: 8 });
const checkpoint = id => {
  const catalog = new DatabaseSync(join(state, "durable/v2/catalog.sqlite"), { readOnly: true });
  try {
    const row = catalog.prepare("SELECT key FROM jobs WHERE json_extract(options,'$.id')=?").get(id);
    const store = new DatabaseSync(join(state, "durable/v2/jobs", row.key, "session.sqlite"), { readOnly: true });
    try { const task = JSON.parse(store.prepare("SELECT record FROM tasks ORDER BY id DESC LIMIT 1").get().record); return task.state.checkpoint ?? task.state.outcome?.result; }
    finally { store.close(); }
  } finally { catalog.close(); }
};
const finish = async (host, id) => {
  let status; await until(async () => { status = await host.call("status", { sessionId: id, verbose: true });
    return !["starting", "running"].includes(status.state); }); return status;
};
const kill = async host => {
  process.kill(host.transport.pid, "SIGKILL");
  await until(() => { try { process.kill(host.transport.pid, 0); return false; } catch { return true; } });
  await host.client.close(); hosts.delete(host);
};
try {
  await mkdir(agent);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off" }));
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: "fake",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000,
      maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { fixture: {
    command: process.execPath, args: [resolve("test/native-fixture.mjs"), dir], exposure: "codemode",
  } } }));
  const barrier = join(dir, "nested-barrier");
  let host = await connect({ TEST_NESTED_TOOL_BARRIER: barrier });
  await spawn(host, "barrier", "BARRIER");
  await until(() => existsSync(barrier + ".started"));
  assert.equal(await contents(join(dir, "effects.txt")), "", "nested tool cannot execute before awaited intent commit returns");
  assert.ok(checkpoint("barrier").snapshot.toolCalls.some(c => c.parentToolCallId === "outer-script" && c.state === "running"));
  await writeFile(barrier + ".release", "release");
  assert.equal((await finish(host, "barrier")).state, "done");
  assert.equal(await contents(join(dir, "effects.txt")), "barrier\n");
  assert.deepEqual(checkpoint("barrier").results, {}, "parent transcript commit also removes nested result staging");
  await host.call("forget", { sessionId: "barrier" });
  await host.client.close(); hosts.delete(host);
  await writeFile(join(dir, "effects.txt"), "");
  host = await connect();
  await spawn(host, "interrupted", "PARALLEL_NESTED");
  await until(() => { const cp = checkpoint("interrupted");
    return Object.values(cp.results).some(v => v.parentToolCallId && JSON.stringify(v.content).includes("COMMITTED_NATIVE_RESULT")); });
  await until(async () => (await contents(join(dir, "effects.txt"))).includes("unknown\n"));
  await kill(host);
  host = await connect();
  const status = await finish(host, "interrupted");
  assert.equal(status.state, "done");
  assert.equal(status.lastText, "NATIVE_RECOVERED");
  assert.ok(status.toolCalls.some(c => c.parentToolCallId && c.state === "ok"));
  assert.ok(status.toolCalls.some(c => c.parentToolCallId && c.state === "error"));
  const messages = requests.findLast(r => JSON.stringify(r.messages).includes("The MCP service restarted.")).messages;
  assert.match(JSON.stringify(messages), /COMMITTED_NATIVE_RESULT/);
  assert.match(JSON.stringify(messages), /outcome is unknown/);
  assert.match(JSON.stringify(messages), /do not replay/);
  assert.deepEqual((await contents(join(dir, "effects.txt"))).trim().split("\n").sort(), ["completed", "unknown"]);
  assert.ok((await contents(join(dir, "connections.txt"))).trim().split("\n").length >= 3, "native MCP reconnects after crash");
  await host.call("forget", { sessionId: "interrupted" });
  console.log("  OK -> native nested intent barrier, parallel committed results, unknown effects, reconnect and no script replay");
} finally {
  await Promise.all([...hosts].map(host => host.client.close()));
  for (const socket of sockets) socket.destroy();
  await new Promise(r => http.close(r));
  await rm(dir, { recursive: true, force: true });
}
