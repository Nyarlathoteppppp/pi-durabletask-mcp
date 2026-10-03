import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Run-clock, model/provider recovery, catalog integrity and interrupted cleanup.
const directory = await mkdtemp(join(tmpdir(), "pi-delegate-claims-"));
const agentDir = join(directory, "agent");
const stateDir = join(directory, "state");
const brokenFile = join(directory, "broken-provider");
const clients = new Set();
const sockets = new Set();
const heldRequests = new Set();
let defaultInterrupted = false;
const waitUntil = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Claims fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const catalog = (sql, ...params) => {
  const db = new DatabaseSync(join(stateDir, "durable", "v2", "catalog.sqlite"));
  try { return db.prepare(sql)[sql.startsWith("SELECT") ? "all" : "run"](...params); } finally { db.close(); }
};
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  // A slow reply lets a too-short deadline fire before the run can finish.
  if (body.includes("SLOW")) await new Promise((resolve) => setTimeout(resolve, 150));
  if (body.includes("HOLD")) { heldRequests.add("late"); return; }
  if (body.includes("INTERRUPT_DEFAULT") && !defaultInterrupted) {
    defaultInterrupted = true;
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "claims-test", object: "chat.completion.chunk", created: 1, model: "one",
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  emit({ role: "assistant", content: "OK" });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));

const connect = async (env = {}) => {
  const client = new Client({ name: "claims-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["test/recovery-server.mjs"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: stateDir,
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", TEST_BROKEN_PROVIDER_FILE: brokenFile, ...env } });
  const host = { client, transport };
  clients.add(host);
  await client.connect(transport);
  host.call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  await host.call("init", { cwd: directory });
  return host;
};
const close = async (host) => { await host.client.close().catch(() => {}); clients.delete(host); };
const settle = async (host, id) => {
  let status;
  await waitUntil(async () => !["starting", "running"].includes((status = await host.call("status", { sessionId: id })).state));
  return status;
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
  const failures = [];
  const scenario = async (name, fn) => {
    try { await fn(); console.log(`    pass: ${name}`); }
    catch (error) {
      failures.push(name);
      console.log(`    FAIL: ${name}: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`);
      for (const host of clients) await host.client.close().catch(() => {});
      clients.clear();
      await rm(brokenFile, { force: true });
    }
  };
  let host;

  await scenario("1 non-durable follow_up gets a fresh run clock", async () => {
  host = await connect();
  // 1. A non-durable follow_up after the first run's time limit gets the full limit again.
  await host.call("spawn", { cwd: directory, id: "clock", prompt: "SLOW plain", tools: [], maxDurationMs: 1000 });
  await settle(host, "clock");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await host.call("follow_up", { sessionId: "clock", prompt: "SLOW again" });
  const clock = await settle(host, "clock");
  assert.equal(clock.state, "done", `follow_up got a fresh run clock: ${JSON.stringify(clock.termination)}`);
  assert.equal(clock.turns, 2);
  await close(host);
  });

  await scenario("2 abort of a finished session is refused", async () => {
  host = await connect();
  // 2. Aborting a finished session is refused and changes nothing.
  await host.call("spawn", { cwd: directory, id: "finished", prompt: "plain", tools: [], durable: true });
  await settle(host, "finished");
  await assert.rejects(() => host.call("abort", { sessionId: "finished" }), /nothing to abort/);
  const first = await host.call("status", { sessionId: "finished" });
  assert.equal(first.state, "done");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await host.call("status", { sessionId: "finished" })).elapsedMs, first.elapsedMs, "elapsed stops at finish");
  await close(host);
  });

  await scenario("3 follow_up checks the provider first", async () => {
  host = await connect();
  // 3. follow_up checks the provider before running, and a refused one leaves the session as it was.
  await host.call("spawn", { cwd: directory, id: "checked", prompt: "plain", tools: [] });
  await settle(host, "checked");
  await writeFile(brokenFile, "test");
  await assert.rejects(() => host.call("follow_up", { sessionId: "checked", prompt: "again" }), /Provider test is not usable/);
  const unchanged = await host.call("status", { sessionId: "checked" });
  assert.equal(unchanged.state, "done");
  assert.equal(unchanged.turns, 1);
  await rm(brokenFile);
  await close(host);
  });

  await scenario("4 answered recovery needs no provider", async () => {
  // 4. A recovery whose answer was already given needs no model call, so broken auth does not stop it.
  host = await connect({ TEST_CRASH_AFTER_ANSWER: "OK" });
  await host.call("spawn", { cwd: directory, id: "answered", prompt: "plain", tools: [], durable: true, maxTurns: 1, maxDurationMs: 1000 }).catch(() => {});
  await waitUntil(() => { try { process.kill(host.transport.pid, 0); return false; } catch { return true; } });
  await close(host);
  assert.equal(catalog("SELECT finished_at FROM jobs WHERE json_extract(options, '$.id') = 'answered'")[0].finished_at, null);
  await writeFile(brokenFile, "test");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  host = await connect();
  await waitUntil(async () => (await host.call("sessions")).sessions.some((s) => s.sessionId === "answered"));
  const answered = await settle(host, "answered");
  assert.equal(answered.state, "done", `recovered without a model call: ${answered.error}`);
  assert.equal(answered.lastText, "OK");
  assert.equal(answered.turns, 1, "a committed answer wins even when both budgets are exhausted");
  await rm(brokenFile);
  await close(host);
  });

  await scenario("5 no new duplicate on a degraded catalog", async () => {
  // 5. While the catalog holds duplicate ids (no unique index), no new duplicate can be created.
  catalog("DROP INDEX IF EXISTS jobs_session");
  catalog("INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at) SELECT ?, 0, agent_dir, options, prompt, finished_at FROM jobs WHERE json_extract(options, '$.id') = 'finished'",
    "00000000-0000-4000-8000-0000000000ee");
  const [a, b] = await Promise.all([connect(), connect()]);
  for (let round = 0; round < 5; round++) {
    const id = `fresh-${round}`;
    await Promise.allSettled([a, b].map((h) => h.call("spawn", { cwd: directory, id, prompt: "plain", tools: [], durable: true })));
    const rows = catalog("SELECT count(*) AS n FROM jobs WHERE json_extract(options, '$.id') = ?", id)[0].n;
    assert.ok(rows <= 1, `no new duplicate for ${id}: ${rows} rows`);
  }
  await close(a); await close(b);
  // This intentional corruption belongs only to this scenario.
  catalog("DELETE FROM jobs WHERE key = ?", "00000000-0000-4000-8000-0000000000ee");
  catalog("CREATE UNIQUE INDEX jobs_session ON jobs (agent_dir, json_extract(options, '$.id'))");
  });

  await scenario("6 Pi's own default model survives a restart", async () => {
    host = await connect({ PI_DELEGATE_MODEL: "" });
    await host.call("spawn", { cwd: directory, id: "pi-default", prompt: "INTERRUPT_DEFAULT", tools: [], durable: true });
    await waitUntil(() => defaultInterrupted);
    process.kill(host.transport.pid, "SIGKILL");
    await close(host);
    assert.equal(JSON.parse(catalog("SELECT options FROM jobs WHERE json_extract(options, '$.id') = 'pi-default'")[0].options).model, "test/one");
    host = await connect({ PI_DELEGATE_MODEL: "" });
    const recovered = await settle(host, "pi-default");
    assert.equal(recovered.state, "done", recovered.error);
    assert.equal(recovered.model, "test/one");
    assert.equal(recovered.turns, 2);
    await host.call("follow_up", { sessionId: "pi-default", prompt: "again" });
    assert.equal((await settle(host, "pi-default")).turns, 3);
    await close(host);
  });

  await scenario("7 a recovery past its deadline needs no provider", async () => {
    host = await connect();
    await host.call("spawn", { cwd: directory, id: "late", prompt: "HOLD", tools: [], durable: true, maxDurationMs: 1000 });
    await waitUntil(() => heldRequests.has("late"));
    process.kill(host.transport.pid, "SIGKILL");
    await close(host);
    await writeFile(brokenFile, "test");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    host = await connect();
    await waitUntil(async () => (await host.call("sessions")).sessions.some((s) => s.sessionId === "late"));
    const late = await settle(host, "late");
    assert.equal(late.state, "aborted", `marked aborted without a model call: ${late.error}`);
    assert.equal(late.termination?.reason, "deadline");
    await rm(brokenFile);
    await close(host);
  });

  await scenario("8 a store left by an interrupted forget is removed", async () => {
    const orphan = join(stateDir, "durable", "v2", "jobs", "00000000-0000-4000-8000-0000000000aa");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "session.sqlite"), "left behind");
    host = await connect();
    await waitUntil(async () => { try { await stat(orphan); return false; } catch { return true; } });
    await close(host);
  });

  await scenario("9 a catalog whose protocol row is missing fails closed", async () => {
    const other = join(directory, "state-missing-protocol");
    await mkdir(join(other, "durable", "v2"), { recursive: true });
    const db = new DatabaseSync(join(other, "durable", "v2", "catalog.sqlite"));
    db.exec("CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.close();
    await assert.rejects(() => connect({ PI_DELEGATE_STATE_DIR: other }));
    const check = new DatabaseSync(join(other, "durable", "v2", "catalog.sqlite"), { readOnly: true });
    assert.equal(check.prepare("SELECT count(*) AS n FROM meta").get().n, 0, "nothing was guessed or written");
    check.close();
  });

  await scenario("10 a recovery past maxTurns needs no provider", async () => {
    host = await connect({ TEST_CRASH_AT_TURN: "1" });
    await host.call("spawn", { cwd: directory, id: "spent", prompt: "plain", tools: [], durable: true, maxTurns: 1 }).catch(() => {});
    await waitUntil(() => { try { process.kill(host.transport.pid, 0); return false; } catch { return true; } });
    await close(host);
    await writeFile(brokenFile, "test");
    host = await connect();
    const spent = await settle(host, "spent");
    assert.equal(spent.state, "aborted", spent.error);
    assert.equal(spent.termination?.reason, "max_turns");
    assert.equal(spent.turns, 1);
    await rm(brokenFile);
    await close(host);
  });

  assert.deepEqual(failures, [], `failed: ${failures.join("; ")}`);
  console.log("  OK -> run clocks, default-model recovery, auth-free completion/budget recovery, duplicate protection, orphan cleanup and fail-closed protocol");
} finally {
  for (const host of clients) await host.client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
