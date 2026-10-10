import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Process deaths at durable boundaries that other tests do not reach. Each case builds the state a
// SIGKILL leaves at that boundary, restarts the server, and checks the invariants that must hold.
const directory = await mkdtemp(join(tmpdir(), "pi-delegate-crash-windows-"));
const agentDir = join(directory, "agent");
const stateDir = join(directory, "state");
const durableDir = join(stateDir, "durable", "v2");
const clients = new Set();
const sockets = new Set();
let requests = 0;
const held = new Set();
const prompts = [];
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests++;
  const encoded = JSON.stringify(JSON.parse(body).messages.findLast((m) => m.role === "user")?.content);
  prompts.push(encoded);
  // The first HOLD request never answers, so the server can be killed mid-run; later ones answer.
  if (encoded.includes("HOLD") && !held.has(encoded)) { held.add(encoded); return; }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "crash", object: "chat.completion.chunk",
    created: 1, model: "one", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  emit({ role: "assistant", content: "ANSWERED" });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const waitUntil = async (predicate, label = "condition") => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const catalogRow = (id) => {
  const catalog = new DatabaseSync(join(durableDir, "catalog.sqlite"), { readOnly: true });
  try { return catalog.prepare("SELECT key, attempts, finished_at FROM jobs WHERE json_extract(options, '$.id') = ?").get(id); }
  finally { catalog.close(); }
};
const connect = async (hooks = {}) => {
  const client = new Client({ name: "crash-windows", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["test/recovery-server.mjs"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: stateDir,
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_RECOVERY_INTERVAL_MS: "200", ...hooks } });
  const host = { client, transport };
  clients.add(host);
  await client.connect(transport);
  host.raw = (name, args = {}) => client.callTool({ name, arguments: args });
  host.call = async (name, args = {}) => {
    const result = await host.raw(name, args);
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  return host;
};
const kill = async (host) => {
  process.kill(host.transport.pid, "SIGKILL");
  await waitUntil(() => { try { process.kill(host.transport.pid, 0); return false; } catch { return true; } }, "server death");
  await host.client.close().catch(() => {}); clients.delete(host);
};
const close = async (host) => { await host.client.close(); clients.delete(host); };
const settled = async (host, id) => {
  let status;
  await waitUntil(async () => {
    const result = await host.raw("status", { sessionId: id });
    if (result.isError) return false;
    status = JSON.parse(result.content[0].text);
    return !["starting", "running"].includes(status.state);
  }, `${id} to settle`);
  return status;
};

try {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one",
    defaultThinkingLevel: "off", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));

  // 1. Death between the catalog insert and Harness.open: the row exists with no snapshot and no
  //    store. No model call can have happened, so recovery runs the task from its original prompt.
  let host = await connect();
  await host.call("spawn", { cwd: directory, id: "no-store", prompt: "HOLD no-store", tools: [], durable: true });
  await waitUntil(() => requests > 0, "the model request");
  await kill(host);
  const { key } = catalogRow("no-store");
  await rm(join(durableDir, "jobs", key), { recursive: true, force: true });
  { const catalog = new DatabaseSync(join(durableDir, "catalog.sqlite"));
    try { catalog.prepare("UPDATE jobs SET snapshot = NULL WHERE key = ?").run(key); } finally { catalog.close(); } }
  const before = prompts.length;
  host = await connect();
  const recovered = await settled(host, "no-store");
  assert.equal(recovered.state, "done", recovered.error);
  assert.equal(recovered.lastText, "ANSWERED");
  assert.ok(prompts.length > before, "recovery called the model");
  assert.ok(prompts.slice(before).every((p) => p.includes("HOLD no-store") && !p.includes("The MCP service restarted.")),
    "the original prompt runs again, not a resume of a conversation that never existed");
  await waitUntil(() => catalogRow("no-store").finished_at > 0, "the finished row");
  await close(host);

  // 2. Death right after a follow_up that renewed its budget commits its task: recovery must run it
  //    under the renewed quota, not the exhausted one it replaced.
  host = await connect();
  await host.call("spawn", { cwd: directory, id: "renewed", prompt: "plain", tools: [], durable: true, maxTurns: 1 });
  assert.equal((await settled(host, "renewed")).remainingTurns, 0);
  await close(host);
  host = await connect({ TEST_CRASH_AFTER_FOLLOWUP_COMMIT: "1" });
  await assert.rejects(async () => {
    await host.call("follow_up", { sessionId: "renewed", prompt: "again", maxTurns: 3 });
    await waitUntil(() => false, "the crash");
  });
  clients.delete(host);
  assert.equal(catalogRow("renewed").finished_at, null, "the committed follow_up is unfinished");
  host = await connect();
  const renewed = await settled(host, "renewed");
  assert.equal(renewed.state, "done", renewed.termination?.reason ?? renewed.error);
  assert.equal(renewed.turns, 2);
  assert.equal(renewed.remainingTurns, 2, "the renewed quota of 3 applies from the follow_up");
  await close(host);
  // 3. A stored job this server's policy now refuses (its cwd is gone) is reported once and held,
  //    not released and claimed again on every recovery tick; forget removes it.
  const gone = join(directory, "gone");
  await mkdir(gone);
  host = await connect();
  await host.call("spawn", { cwd: gone, id: "blocked", prompt: "HOLD blocked", tools: [], durable: true });
  await waitUntil(() => prompts.some((p) => p.includes("HOLD blocked")), "the blocked model request");
  await kill(host);
  await rm(gone, { recursive: true, force: true });
  host = await connect();
  const blocked = await settled(host, "blocked");
  assert.equal(blocked.state, "error");
  assert.match(blocked.error, /policy/);
  await new Promise((resolve) => setTimeout(resolve, 1500)); // several recovery ticks
  assert.equal(catalogRow("blocked").attempts, 1, "claimed once, not on every tick");
  await host.call("forget", { sessionId: "blocked" });
  assert.equal(catalogRow("blocked"), undefined);
  await close(host);

  // 4. A job past its recovery attempts keeps its lock even when history eviction runs.
  host = await connect();
  await host.call("spawn", { cwd: directory, id: "spent", prompt: "HOLD spent", tools: [], durable: true });
  await waitUntil(() => prompts.some((p) => p.includes("HOLD spent")), "the spent model request");
  await kill(host);
  { const catalog = new DatabaseSync(join(durableDir, "catalog.sqlite"));
    try { catalog.prepare("UPDATE jobs SET attempts = 5 WHERE json_extract(options, '$.id') = 'spent'").run(); } finally { catalog.close(); } }
  host = await connect({ PI_DELEGATE_HISTORY: "1" });
  assert.equal((await settled(host, "spent")).state, "error");
  await host.call("run", { cwd: directory, prompt: "plain", tools: [] }); // a finished session pushes history over 1
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(catalogRow("spent").attempts, 6, "not released and claimed again after eviction");
  await close(host);
  console.log("  OK -> crashes before the store exists or after a renewing follow_up commits recover correctly; refused or spent recoveries are held, not retried every tick");
} finally {
  for (const host of clients) await host.client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
