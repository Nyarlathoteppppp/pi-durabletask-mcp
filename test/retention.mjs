import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const directory = await mkdtemp(join(tmpdir(), "pi-delegate-retention-"));
const agentDir = join(directory, "agent");
const stateDir = join(directory, "state");
const v2 = join(stateDir, "durable", "v2");
const clients = new Set();
const sockets = new Set();
const waitUntil = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Retention fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const catalog = (sql, ...params) => {
  const db = new DatabaseSync(join(v2, "catalog.sqlite"));
  try { return db.prepare(sql)[sql.startsWith("SELECT") ? "all" : "run"](...params); } finally { db.close(); }
};
const row = (id) => catalog("SELECT key, finished_at FROM jobs WHERE json_extract(options, '$.id') = ?", id)[0];
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (body.includes("HOLD")) return;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "retention-test", object: "chat.completion.chunk", created: 1, model: "one",
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  emit({ role: "assistant", content: "OK" });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));

const connect = async ({ server = "dist/index.js", ...env } = {}) => {
  const client = new Client({ name: "retention-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: stateDir,
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", ...env } });
  const host = { client, transport };
  clients.add(host);
  await client.connect(transport);
  host.call = async (name, args = {}) => {
    // These tests exercise durability, which is opt-in for new delegates.
    if ((name === "spawn" || name === "run") && args.durable === undefined) args = { ...args, durable: true };
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  await host.call("init", { cwd: directory });
  return host;
};
const close = async (host) => { await host.client.close(); clients.delete(host); };
const kill = async (host) => {
  process.kill(host.transport.pid, "SIGKILL");
  await waitUntil(() => { try { process.kill(host.transport.pid, 0); return false; } catch { return true; } });
  await close(host);
};
const done = async (host, id) => waitUntil(async () => (await host.call("status", { sessionId: id })).state === "done");
const lockFiles = () => existsSync(join(v2, "ownership")) ? readdirSync(join(v2, "ownership")) : [];

try {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off", enabledModels: ["test/*"],
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000,
      maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));

  // 1. durable: false writes nothing, works while the host lives, and is gone after it.
  let host = await connect({ PI_DELEGATE_HISTORY: "1" });
  await host.call("spawn", { cwd: directory, id: "ephemeral", prompt: "plain", tools: [], durable: false });
  await done(host, "ephemeral");
  assert.equal((await host.call("status", { sessionId: "ephemeral" })).durable, false);
  await host.call("follow_up", { sessionId: "ephemeral", prompt: "again" });
  await done(host, "ephemeral");
  assert.equal(row("ephemeral"), undefined, "no catalog row");
  assert.deepEqual(readdirSync(join(v2, "jobs")), [], "no session store");
  assert.deepEqual(lockFiles(), [], "no ownership lock");

  // 2. Evicting from memory keeps durable sessions on disk, listed as stored and loadable by id.
  await host.call("spawn", { cwd: directory, id: "first", prompt: "plain", tools: [] });
  await done(host, "first");
  await host.call("spawn", { cwd: directory, id: "second", prompt: "plain", tools: [] });
  await done(host, "second");
  await waitUntil(async () => (await host.call("sessions")).stored.some((s) => s.sessionId === "first"));
  assert.ok(row("first").finished_at > 0, "finished_at recorded");
  assert.ok(existsSync(join(v2, "jobs", row("first").key)), "eviction does not delete the store");
  await assert.rejects(() => host.call("spawn", { cwd: directory, id: "first", prompt: "plain", tools: [] }),
    /already in use/, "a stored id is still taken");

  // 3. Any process can read a finished session, even one another process has loaded; only taking
  //    it over for follow_up needs that process to let go.
  const other = await connect();
  assert.equal((await other.call("status", { sessionId: "second" })).state, "done", "readable while loaded elsewhere");
  assert.equal((await other.call("wait", { sessionId: "second", timeoutMs: 250 })).state, "done");
  await assert.rejects(() => other.call("follow_up", { sessionId: "second", prompt: "x" }), /loaded by another running MCP process/);
  assert.equal((await other.call("status", { sessionId: "first" })).lastText, "OK", "stored session readable without loading");
  assert.equal((await other.call("sessions")).sessions.some((s) => s.sessionId === "first"), false, "reading did not load it");
  await kill(host);
  assert.equal((await other.call("status", { sessionId: "second" })).state, "done");
  await assert.rejects(() => other.call("status", { sessionId: "ephemeral" }), /Unknown sessionId/, "ephemeral is gone");
  await close(other);

  // 4. Startup sweep deletes finished sessions past retention, and their lock files; others stay.
  //    Retention is per session: one kept for 30 days outlives the 7-day default.
  host = await connect();
  await host.call("spawn", { cwd: directory, id: "kept", prompt: "plain", tools: [], retentionDays: 30 });
  await done(host, "kept");
  assert.equal((await host.call("status", { sessionId: "kept" })).retentionDays, 30);
  await close(host);
  for (const id of ["first", "kept"]) catalog("UPDATE jobs SET finished_at = ? WHERE key = ?", Date.now() - 8 * 86_400_000, row(id).key);
  const firstKey = row("first").key;
  host = await connect();
  await waitUntil(() => row("first") === undefined);
  assert.ok(row("kept"), "a 30-day session survives 8 days");
  assert.equal(existsSync(join(v2, "jobs", firstKey)), false);
  await waitUntil(() => !lockFiles().includes(`${firstKey}.sqlite`));
  assert.ok(row("second"), "unexpired session kept");

  // 5. Over the size limit, finished sessions go oldest first. Unfinished ones are never deleted,
  //    including one that nobody holds because recovery capacity is full.
  await host.call("spawn", { cwd: directory, id: "running-a", prompt: "HOLD", tools: [] });
  await host.call("spawn", { cwd: directory, id: "running-b", prompt: "HOLD", tools: [] });
  await waitUntil(() => row("running-a") !== undefined && row("running-b") !== undefined);
  await kill(host);
  host = await connect({ PI_DELEGATE_STORAGE_LIMIT_MB: "0.001", PI_DELEGATE_MAX_CONCURRENT: "1" });
  await waitUntil(() => row("second") === undefined);
  assert.equal(row("running-a")?.finished_at, null, "unfinished session survives storage pressure");
  assert.equal(row("running-b")?.finished_at, null, "unclaimed unfinished session survives storage pressure");
  await close(host);

  // 6. forget deletes a stored session without loading it.
  host = await connect();
  await waitUntil(async () => (await host.call("sessions")).sessions.filter((s) => s.state === "running").length === 2);
  for (const id of ["running-a", "running-b"]) await host.call("abort", { sessionId: id });
  await waitUntil(() => row("running-a")?.finished_at > 0 && row("running-b")?.finished_at > 0);
  await close(host);
  host = await connect();
  await host.call("forget", { sessionId: "running-a" });
  assert.equal(row("running-a"), undefined);
  assert.ok(row("running-b"));
  await close(host);
  // 7. A stored session is loaded under this process's policy, not the one it was created under.
  host = await connect({ PI_DELEGATE_ALLOW_WRITE: "1" });
  await host.call("spawn", { cwd: directory, id: "writer", prompt: "plain", tools: ["write"] });
  await done(host, "writer");
  await close(host);
  host = await connect();
  await assert.rejects(() => host.call("follow_up", { sessionId: "writer", prompt: "write now" }), /blocked/,
    "a read-only host does not regain write tools through history");
  assert.equal((await host.call("status", { sessionId: "writer" })).state, "done", "reading needs no tool policy");
  await close(host);

  // 8. Loading a stored session into a full history keeps it; the least recently used one goes.
  host = await connect({ PI_DELEGATE_HISTORY: "1" });
  await host.call("spawn", { cwd: directory, id: "old", prompt: "plain", tools: [] });
  await done(host, "old");
  await host.call("spawn", { cwd: directory, id: "new", prompt: "plain", tools: [] });
  await done(host, "new");
  await waitUntil(async () => (await host.call("sessions")).stored.some((s) => s.sessionId === "old"));
  await host.call("follow_up", { sessionId: "old", prompt: "again" });
  await done(host, "old");
  assert.equal((await host.call("status", { sessionId: "old" })).turns, 2, "the loaded session was not evicted under it");
  await close(host);

  // 9. A crash right after a follow-up task commits leaves the job unfinished, so recovery resumes
  //    it at startup and the sweep cannot take it for finished.
  host = await connect({ server: "test/recovery-server.mjs", TEST_CRASH_AFTER_FOLLOWUP_COMMIT: "1" });
  await assert.rejects(() => host.call("follow_up", { sessionId: "new", prompt: "after crash" }));
  clients.delete(host);
  assert.equal(row("new").finished_at, null, "a committed follow-up is never marked finished");
  host = await connect();
  assert.ok((await host.call("sessions")).sessions.some((s) => s.sessionId === "new"), "startup recovery resumed it");
  await done(host, "new");
  assert.equal((await host.call("status", { sessionId: "new" })).turns, 2);
  assert.ok(row("new").finished_at > 0);
  await close(host);

  console.log("  OK -> non-durable writes nothing, eviction keeps disk, lazy load and cross-host hold, retention and tombstones, size limit spares unfinished, forget stored, policy on load, LRU keeps loaded history, follow-up crash window");
} finally {
  for (const host of clients) await host.client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
