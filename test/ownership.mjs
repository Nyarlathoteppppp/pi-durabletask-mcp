import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const directory = await mkdtemp(join(tmpdir(), "pi-delegate-ownership-"));
const agentDir = join(directory, "agent");
const stateDir = join(directory, "state");
const v2 = join(stateDir, "durable", "v2");
const requests = [];
const clients = new Set();
const sockets = new Set();
const waitUntil = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Ownership fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const catalog = (sql, ...params) => {
  const db = new DatabaseSync(join(v2, "catalog.sqlite"));
  try { return db.prepare(sql)[sql.startsWith("SELECT") ? "get" : "run"](...params); } finally { db.close(); }
};
const keyOf = (id) => catalog("SELECT key FROM jobs WHERE json_extract(options, '$.id') = ?", id).key;
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  const encoded = JSON.stringify(request.messages);
  // Every HOLD turn stays open, so the task is non-terminal whenever its host dies.
  if (encoded.includes("HOLD")) return;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "ownership-test", object: "chat.completion.chunk", created: 1, model: "one",
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  emit({ role: "assistant", content: "OK" });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));

const connect = async (hooks = {}) => {
  const client = new Client({ name: "ownership-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["test/recovery-server.mjs"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: stateDir,
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", ...hooks } });
  const host = { client, transport };
  clients.add(host);
  try { await client.connect(transport); } catch (error) { clients.delete(host); throw error; }
  host.call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
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
const owned = async (host, id) => (await host.call("sessions")).sessions.some((s) => s.sessionId === id);
const holding = async (id) => {
  const host = await connect();
  await host.call("spawn", { cwd: directory, id, prompt: `HOLD ${id}`, tools: [] });
  await waitUntil(() => requests.some((r) => JSON.stringify(r.messages).includes(`HOLD ${id}`)));
  return host;
};

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

  // A v1 store left by an older build: dead PID, no lock. v2 hosts must neither claim nor touch it.
  const legacyKey = "00000000-0000-4000-8000-000000000001";
  await mkdir(join(stateDir, "durable", legacyKey), { recursive: true });
  await writeFile(join(stateDir, "durable", legacyKey, "session.sqlite"), "v1 store");
  const legacy = new DatabaseSync(join(stateDir, "durable", "catalog.sqlite"));
  legacy.exec(`CREATE TABLE jobs (key TEXT PRIMARY KEY, pid INTEGER NOT NULL, agent_dir TEXT NOT NULL, options TEXT NOT NULL, prompt TEXT NOT NULL);`);
  legacy.prepare("INSERT INTO jobs VALUES (?, 0, ?, ?, 'old')").run(legacyKey, agentDir, JSON.stringify({ id: "legacy", cwd: directory }));
  legacy.close();

  // 1. A live owner stopped by SIGSTOP keeps its lock: nobody takes over a hung process.
  let owner = await holding("stopped");
  process.kill(owner.transport.pid, "SIGSTOP");
  const bystander = await connect();
  assert.equal(await owned(bystander, "stopped"), false, "a stopped owner is not taken over");
  await close(bystander);
  process.kill(owner.transport.pid, "SIGCONT");
  assert.equal(await owned(owner, "stopped"), true);
  assert.equal(await owned(owner, "legacy"), false, "v1 jobs are invisible to v2 hosts");

  // 2. The PID recorded for a dead owner now belongs to an unrelated live process. The lock is
  //    free, so the job is recovered; PID-based ownership would have waited forever.
  await kill(owner);
  const stranger = spawn("sleep", ["30"]);
  catalog("UPDATE jobs SET pid = ? WHERE key = ?", stranger.pid, keyOf("stopped"));
  const heldBefore = requests.length;
  owner = await connect();
  assert.equal(await owned(owner, "stopped"), true, "a reused PID does not keep a dead owner's job");
  // The recovery turn has started and its model call is in flight; that is not progress yet.
  await waitUntil(() => requests.length > heldBefore);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(catalog("SELECT attempts FROM jobs WHERE key = ?", keyOf("stopped")).attempts, 1,
    "starting a turn does not clear attempts");
  stranger.kill();

  // 3. Four hosts race for one abandoned job; exactly one wins.
  await kill(owner);
  const racers = await Promise.all([connect(), connect(), connect(), connect()]);
  const winners = [];
  for (const racer of racers) if (await owned(racer, "stopped")) winners.push(racer);
  assert.equal(winners.length, 1, "an abandoned job has exactly one new owner");
  for (const racer of racers) if (racer !== winners[0]) await close(racer);
  owner = winners[0];

  // 4. Recovery reads the checkpoint, closes the store without releasing it, then reopens it.
  //    Another host arriving in that window must find the job owned.
  await kill(owner);
  const barrier = join(directory, "close-barrier");
  const recovering = connect({ TEST_CLOSE_BARRIER: barrier });
  await waitUntil(() => existsSync(barrier + ".started"));
  const intruder = await connect();
  assert.equal(await owned(intruder, "stopped"), false, "ownership spans the recovery reopen");
  await close(intruder);
  await writeFile(barrier + ".release", "release");
  owner = await recovering;
  assert.equal(await owned(owner, "stopped"), true);
  // Every claim above followed a kill without a completed turn, so each one counted.
  assert.equal(catalog("SELECT attempts FROM jobs WHERE key = ?", keyOf("stopped")).attempts, 3);
  await owner.call("abort", { sessionId: "stopped" });
  await owner.call("forget", { sessionId: "stopped" });

  // 5. A job that kills every host recovering it is claimed MAX_RECOVERY_ATTEMPTS times, then
  //    reported instead of resumed. Hosts keep starting; forget then removes it.
  await owner.call("spawn", { cwd: directory, id: "looping", prompt: "HOLD looping", tools: [] });
  await waitUntil(() => requests.some((r) => JSON.stringify(r.messages).includes("HOLD looping")));
  await kill(owner);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(() => connect({ TEST_CRASH_ON_RECOVERY: "1" }), `crash ${attempt}`);
    assert.equal(catalog("SELECT attempts FROM jobs WHERE key = ?", keyOf("looping")).attempts, attempt);
  }
  const before = requests.length;
  owner = await connect({ TEST_CRASH_ON_RECOVERY: "1" });
  const status = await owner.call("status", { sessionId: "looping" });
  assert.equal(status.state, "error");
  assert.match(status.error, /Recovery stopped/);
  assert.equal(requests.length, before, "an exhausted job is not resumed");
  const key = keyOf("looping");
  await owner.call("forget", { sessionId: "looping" });
  assert.equal(catalog("SELECT key FROM jobs WHERE key = ?", key), undefined);
  assert.equal(existsSync(join(v2, "jobs", key)), false, "forget removes the job data");
  assert.ok(readdirSync(join(v2, "ownership")).includes(`${key}.sqlite`), "the lock file stays as a tombstone");
  await close(owner);

  // 6. Progress clears the counter, and finished history never counts as a recovery attempt.
  owner = await connect();
  await owner.call("spawn", { cwd: directory, id: "finished", prompt: "plain", tools: [] });
  await waitUntil(async () => (await owner.call("status", { sessionId: "finished" })).state === "done");
  // As if it had finished on its last allowed recovery: a finished task is never reported exhausted.
  catalog("UPDATE jobs SET attempts = 3 WHERE key = ?", keyOf("finished"));
  await kill(owner);
  owner = await connect();
  assert.equal((await owner.call("status", { sessionId: "finished" })).state, "done", "finished at the cap is still done");
  for (let restart = 0; restart < 3; restart++) {
    await kill(owner);
    owner = await connect();
  }
  assert.equal((await owner.call("status", { sessionId: "finished" })).state, "done");
  assert.equal(catalog("SELECT attempts FROM jobs WHERE key = ?", keyOf("finished")).attempts, 0);
  await close(owner);

  const untouched = new DatabaseSync(join(stateDir, "durable", "catalog.sqlite"), { readOnly: true });
  assert.equal(untouched.prepare("SELECT pid FROM jobs WHERE key = ?").get(legacyKey).pid, 0);
  untouched.close();
  assert.equal(await readFile(join(stateDir, "durable", legacyKey, "session.sqlite"), "utf8"), "v1 store");

  // 7. A catalog from another ownership protocol fails closed.
  catalog("UPDATE meta SET value = '3' WHERE name = 'ownership_protocol'");
  await assert.rejects(() => connect(), "protocol mismatch stops the host");
  console.log("  OK -> SIGSTOP owner kept, PID reuse recovered, single winner of 4, ownership across reopen, crash-loop cap, v1 isolation, protocol check");
} finally {
  for (const host of clients) await host.client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
