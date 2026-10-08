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
  const recorded = JSON.parse(catalog("SELECT snapshot FROM jobs WHERE key = ?", row("second").key)[0].snapshot);
  const boundary = recorded.runStartedAt ?? recorded.startedAt;
  recorded.notices = [
    { type: "warning", message: "previous run", at: new Date(Date.parse(boundary) - 1).toISOString() },
    { type: "info", message: "current run", at: boundary },
  ];
  catalog("UPDATE jobs SET snapshot = ? WHERE key = ?", JSON.stringify(recorded), row("second").key);
  const other = await connect();
  assert.equal((await other.call("status", { sessionId: "second" })).state, "done", "readable while loaded elsewhere");
  const storedWait = await other.call("wait", { sessionId: "second", timeoutMs: 250 });
  assert.equal(storedWait.state, "done");
  assert.equal(storedWait.nextAction, "finish");
  assert.equal("toolCalls" in storedWait, false, "stored waits use the same minimal output");
  assert.deepEqual(storedWait.notices.map((n) => n.message), ["current run"]);
  const storedBatch = await other.call("wait", { sessionIds: ["second"], until: "all_settled" });
  assert.deepEqual(storedBatch.sessions[0].notices.map((n) => n.message), ["current run"], "stored batch wait filters historical notices");
  const storedVerbose = await other.call("wait", { sessionId: "second", verbose: true, timeoutMs: 250 });
  assert.equal(storedVerbose.durable, true);
  assert.equal(storedVerbose.nextAction, "finish");
  assert.deepEqual(storedVerbose.notices.map((n) => n.message), ["previous run", "current run"]);
  await assert.rejects(() => other.call("follow_up", { sessionId: "second", prompt: "x" }), /running or loaded in another MCP process/);
  assert.equal((await other.call("status", { sessionId: "first" })).lastText, "OK", "stored session readable without loading");
  assert.equal((await other.call("sessions")).sessions.some((s) => s.sessionId === "first"), false, "reading did not load it");
  await kill(host);
  assert.equal((await other.call("status", { sessionId: "second" })).state, "done");
  await assert.rejects(() => other.call("status", { sessionId: "ephemeral" }), /Unknown sessionId: ephemeral\. Sessions without durable: true end with the MCP process/, "ephemeral is gone, and the error says why");
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
  const waiting = await Promise.allSettled(["running-a", "running-b"].map((id) => host.call("status", { sessionId: id })));
  assert.ok(waiting.some((r) => r.status === "rejected" && /waiting for recovery/.test(String(r.reason))),
    "the session without a free slot says it is waiting for recovery");
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

  // 10. Two processes spawning the same durable id at once: exactly one gets it.
  const [hostA, hostB] = await Promise.all([connect(), connect()]);
  const raced = await Promise.allSettled([hostA, hostB].map((h) => h.call("spawn", { cwd: directory, id: "same-id", prompt: "plain", tools: [] })));
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1, "one spawn wins");
  assert.match(String(raced.find((r) => r.status === "rejected").reason), /already in use/);
  assert.equal(catalog("SELECT count(*) AS n FROM jobs WHERE json_extract(options, '$.id') = 'same-id'")[0].n, 1);
  await close(hostA); await close(hostB);

  // 11. A crash after a follow-up's terminal commit but before its final state is recorded must not
  //     leave the previous run's state marked finished: the row stays unfinished, and recovery
  //     records the new state.
  host = await connect();
  await host.call("spawn", { cwd: directory, id: "two-runs", prompt: "plain", tools: [] });
  await done(host, "two-runs");
  await close(host);
  host = await connect({ server: "test/recovery-server.mjs", TEST_CRASH_BEFORE_FINAL: "2" });
  await assert.rejects(async () => {
    await host.call("follow_up", { sessionId: "two-runs", prompt: "again" });
    await waitUntil(() => false);
  });
  clients.delete(host);
  assert.equal(row("two-runs").finished_at, null, "not marked finished with the old snapshot");
  host = await connect();
  await waitUntil(() => row("two-runs")?.finished_at > 0);
  assert.equal((await host.call("status", { sessionId: "two-runs" })).turns, 2, "the recorded state is the second run's");
  await close(host);

  // 12. Retention is fixed when the session is created, whatever default a later process has.
  host = await connect({ PI_DELEGATE_RETENTION_DAYS: "30" });
  await host.call("spawn", { cwd: directory, id: "env-default", prompt: "plain", tools: [] });
  await done(host, "env-default");
  await close(host);
  catalog("UPDATE jobs SET finished_at = ? WHERE key = ?", Date.now() - 8 * 86_400_000, row("env-default").key);
  host = await connect();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(row("env-default"), "kept 30 days, not this process's 7");
  await close(host);

  // 13. Over the size limit, finished sessions this process still has loaded are deleted too.
  host = await connect({ PI_DELEGATE_STORAGE_LIMIT_MB: "0.001", PI_DELEGATE_HISTORY: "50" });
  await host.call("spawn", { cwd: directory, id: "loaded-big", prompt: "plain", tools: [] });
  assert.ok(row("loaded-big"), "stored while it runs");
  await waitUntil(() => row("loaded-big") === undefined);
  await close(host);

  // 14. A catalog that already holds duplicate ids (from before the index) still starts.
  host = await connect();
  await host.call("spawn", { cwd: directory, id: "dup-src", prompt: "plain", tools: [] });
  await done(host, "dup-src");
  await close(host);
  catalog("DROP INDEX jobs_session");
  catalog("INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at) SELECT ?, 0, agent_dir, options, prompt, finished_at FROM jobs WHERE key = ?",
    "00000000-0000-4000-8000-0000000000dd", row("dup-src").key);
  host = await connect();
  assert.equal((await host.call("status", { sessionId: "dup-src" })).state, "done", "starts despite duplicates");
  await close(host);
  catalog("DELETE FROM jobs WHERE key = ?", "00000000-0000-4000-8000-0000000000dd");

  console.log("  OK -> non-durable writes nothing, eviction keeps disk, lazy load and cross-host hold, retention and tombstones, size limit spares unfinished, forget stored, policy on load, LRU keeps loaded history, follow-up crash window");
} finally {
  for (const host of clients) await host.client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
