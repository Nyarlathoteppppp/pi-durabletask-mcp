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
  if (encoded.includes("STUCK") && !encoded.includes("again")) return; // never answers, even on recovery
  // The first HOLD request never answers, so the server can be killed mid-run; later ones answer.
  if (encoded.includes("HOLD") && !held.has(encoded)) { held.add(encoded); return; }
  if (encoded.includes("SLOW")) await new Promise((resolve) => setTimeout(resolve, 1500));
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
  // 3. A stored job this server's policy now refuses (its cwd is gone) is recorded as finished with
  //    its error, not claimed again on every tick nor held by the process that met it: any window
  //    reads the error and can forget it.
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
  const elsewhere = await connect({ PI_DELEGATE_RECOVERY_INTERVAL_MS: "600000" });
  assert.match((await elsewhere.call("status", { sessionId: "blocked" })).error, /policy/, "readable in another window");
  await elsewhere.call("forget", { sessionId: "blocked" });
  assert.equal(catalogRow("blocked"), undefined);
  await close(elsewhere);
  await close(host);

  // 4. A job past its recovery attempts is recorded the same way: not reclaimed even when history
  //    eviction runs, and forgettable from another window.
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
  assert.equal(catalogRow("spent").attempts, 6, "not claimed again after eviction");
  const other = await connect({ PI_DELEGATE_RECOVERY_INTERVAL_MS: "600000" });
  assert.match((await other.call("status", { sessionId: "spent" })).error, /Recovery stopped/);
  await other.call("forget", { sessionId: "spent" });
  assert.equal(catalogRow("spent"), undefined);
  await close(other);
  await close(host);
  // 5. A task another process recovered in the background is released once it settles, so the window
  //    that continues the work can follow it up instead of finding it held elsewhere.
  host = await connect();
  await host.call("spawn", { cwd: directory, id: "handover", prompt: "HOLD handover", tools: [], durable: true });
  await waitUntil(() => prompts.some((p) => p.includes("HOLD handover")), "the handover model request");
  await kill(host);
  const recoverer = await connect();
  await waitUntil(() => catalogRow("handover")?.finished_at > 0, "background recovery to finish");
  const window = await connect({ PI_DELEGATE_RECOVERY_INTERVAL_MS: "600000" });
  await waitUntil(async () => !(await window.raw("follow_up", { sessionId: "handover", prompt: "again" })).isError, "follow_up from another window");
  assert.equal((await settled(window, "handover")).state, "done");
  await close(window);
  await close(recoverer);

  // 6. wait on a session running in another process waits for it there, instead of failing at once.
  const runner = await connect();
  await runner.call("spawn", { cwd: directory, id: "elsewhere", prompt: "SLOW elsewhere", tools: [], durable: true });
  const watcher = await connect({ PI_DELEGATE_RECOVERY_INTERVAL_MS: "600000" });
  const meanwhile = await watcher.call("wait", { sessionId: "elsewhere", until: "settled", timeoutMs: 250 });
  assert.deepEqual([meanwhile.state, meanwhile.runningElsewhere], ["running", true]);
  const waited = await watcher.call("wait", { sessionId: "elsewhere", until: "settled", timeoutMs: 15000 });
  assert.equal(waited.state, "done");
  assert.equal(waited.lastText, "ANSWERED");
  await close(watcher);
  await close(runner);
  // 7. The same release when recovery only records an already committed result (death after the
  //    terminal commit, before the catalog row was finished): no run starts, yet it is released.
  host = await connect({ TEST_CRASH_BEFORE_FINAL: "1" });
  await host.call("spawn", { cwd: directory, id: "committed", prompt: "plain", tools: [], durable: true }).catch(() => {});
  await waitUntil(() => { try { process.kill(host.transport.pid, 0); return false; } catch { return true; } }, "the crash before final");
  await host.client.close().catch(() => {}); clients.delete(host);
  assert.equal(catalogRow("committed").finished_at, null);
  const recorder = await connect();
  await waitUntil(() => catalogRow("committed")?.finished_at > 0, "the recorded result");
  const later = await connect({ PI_DELEGATE_RECOVERY_INTERVAL_MS: "600000" });
  await waitUntil(async () => !(await later.raw("follow_up", { sessionId: "committed", prompt: "again" })).isError, "follow_up after a recorded recovery");
  await close(later);
  await close(recorder);

  // 8. A batch wait that times out on a local run still reports a remote session that finished meanwhile.
  const far = await connect();
  await far.call("spawn", { cwd: directory, id: "far", prompt: "SLOW far", tools: [], durable: true });
  const near = await connect({ PI_DELEGATE_RECOVERY_INTERVAL_MS: "600000" });
  await near.call("spawn", { cwd: directory, id: "near", prompt: "HOLD near", tools: [] });
  const mixed = await near.call("wait", { sessionIds: ["near", "far"], until: "all_settled", timeoutMs: 4000 });
  assert.deepEqual(mixed.settled, ["far"]);
  assert.equal(mixed.sessions.find((s) => s.sessionId === "far").lastText, "ANSWERED");
  await close(near);
  await close(far);
  // 9. A background recovery that ends by abort (here its deadline) is released after the abort drains.
  host = await connect();
  await host.call("spawn", { cwd: directory, id: "stuck", prompt: "STUCK", tools: [], durable: true, maxDurationMs: 4000 });
  await waitUntil(() => prompts.some((p) => p.includes("STUCK")), "the stuck model request");
  await kill(host);
  const aborter = await connect();
  await waitUntil(() => catalogRow("stuck")?.finished_at > 0, "the deadline abort");
  const next = await connect({ PI_DELEGATE_RECOVERY_INTERVAL_MS: "600000" });
  await waitUntil(async () => !(await next.raw("follow_up", { sessionId: "stuck", prompt: "again", maxTurns: 3 })).isError, "follow_up after an aborted recovery");
  await close(next);
  await close(aborter);
  // 10. A recovery whose final catalog write fails stays loaded with its error, holding the job,
  //     instead of being released and reclaimed while the row still reads unfinished.
  host = await connect();
  await host.call("spawn", { cwd: directory, id: "unwritten", prompt: "HOLD unwritten", tools: [], durable: true });
  await waitUntil(() => prompts.some((p) => p.includes("HOLD unwritten")), "the unwritten model request");
  await kill(host);
  const failing = await connect({ TEST_FAIL_FINAL: "unwritten" });
  await waitUntil(async () => {
    const r = await failing.raw("status", { sessionId: "unwritten" });
    return !r.isError && JSON.parse(r.content[0].text).state === "error";
  }, "the failed final write");
  await new Promise((resolve) => setTimeout(resolve, 1500)); // several recovery ticks
  assert.equal(catalogRow("unwritten").attempts, 1, "held after the failed write, not reclaimed");
  assert.match(JSON.parse((await failing.raw("status", { sessionId: "unwritten" })).content[0].text).error, /persistence failed/);
  await close(failing);
  // 11. forget removes an unfinished job no process holds (here its recovery failed on auth and was
  //     handed back): holding the lock is all deletion needs, and nobody is running it.
  host = await connect();
  await host.call("spawn", { cwd: directory, id: "abandoned", prompt: "HOLD abandoned", tools: [], durable: true });
  await waitUntil(() => prompts.some((p) => p.includes("HOLD abandoned")), "the abandoned model request");
  await kill(host);
  const brokenAuth = await connect({ TEST_BROKEN_PROVIDER: "test", PI_DELEGATE_RECOVERY_INTERVAL_MS: "600000" });
  assert.equal(catalogRow("abandoned").finished_at, null, "still unfinished after the failed recovery");
  await brokenAuth.call("forget", { sessionId: "abandoned" });
  assert.equal(catalogRow("abandoned"), undefined);
  await close(brokenAuth);
  // 12. A durable run cancelled while its store is opening ends aborted, recorded as such: no recovery
  //     tick runs the cancelled work later, and forget removes it.
  const slow = await connect({ TEST_OPEN_DELAY_MS: "1500" });
  const cancel = new AbortController();
  const cancelled = slow.client.callTool({ name: "run", arguments: { cwd: directory, id: "cancelled", prompt: "CANCELLED work",
    tools: [], durable: true } }, undefined, { signal: cancel.signal }).catch(() => "cancelled");
  await waitUntil(() => catalogRow("cancelled") !== undefined, "the inserted row");
  cancel.abort();
  assert.equal(await cancelled, "cancelled");
  await waitUntil(() => catalogRow("cancelled")?.finished_at > 0, "the cancelled run recorded as finished");
  const ticker = await connect();
  await new Promise((resolve) => setTimeout(resolve, 1500)); // several recovery ticks
  assert.ok(!prompts.some((p) => p.includes("CANCELLED work")), "cancelled work never reached the model");
  assert.equal((await ticker.call("status", { sessionId: "cancelled" })).state, "aborted");
  await ticker.call("forget", { sessionId: "cancelled" });
  assert.equal(catalogRow("cancelled"), undefined);
  await close(ticker);
  await close(slow);
  console.log("  OK -> crashes before the store exists or after a renewing follow_up commits recover correctly; refused or spent recoveries are recorded with their error for every window, not retried every tick; recovered tasks are released for other windows, which can also wait on them; forget removes unheld unfinished jobs; a run cancelled while opening stays cancelled");
} finally {
  for (const host of clients) await host.client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
