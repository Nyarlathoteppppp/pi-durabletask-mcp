import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const directory = await mkdtemp(join(tmpdir(), "pi-delegate-usability-"));
const agentDir = join(directory, "agent");
const clients = new Set();
const sockets = new Set();
const waitUntil = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Usability fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const encoded = JSON.stringify(request.messages);
  const toolResults = request.messages.filter((m) => m.role === "tool").length;
  if (encoded.includes("SLOW")) await new Promise((resolve) => setTimeout(resolve, 1500));
  // Paced replies make intermediate progress observable to a waiting caller.
  if (encoded.includes("PACED")) await new Promise((resolve) => setTimeout(resolve, 150));
  if (encoded.includes("FAIL503")) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "service unavailable" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "usability-test", object: "chat.completion.chunk", created: 1, model: "one",
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  const call = (name, args) => {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: `call-${toolResults}`, type: "function",
      function: { name, arguments: JSON.stringify(args) } }] });
    emit({}, "tool_calls");
  };
  if (encoded.includes("MANY_CALLS") && toolResults < 7) call("ls", { path: ".", limit: toolResults + 1, ignore: "x".repeat(300) });
  else if (encoded.includes("GREP") && toolResults < 1) call("grep", { pattern: "needle" });
  else { emit({ role: "assistant", content: "OK" }); emit({}, "stop"); }
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));

const connect = async (env = {}) => {
  const client = new Client({ name: "usability-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["test/recovery-server.mjs"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(directory, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", ...env } });
  const host = { client, transport };
  clients.add(host);
  await client.connect(transport);
  host.call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  host.init = await host.call("init", { cwd: directory });
  return host;
};
const close = async (host) => { await host.client.close(); clients.delete(host); };
const settle = async (host, id) => {
  let status;
  await waitUntil(async () => !["starting", "running"].includes((status = await host.call("status", { sessionId: id })).state));
  return status;
};

try {
  await mkdir(join(agentDir, "bin"), { recursive: true });
  await writeFile(join(directory, "haystack.txt"), "a needle here\n");
  // A short retry budget keeps the provider-failure case fast; the policy itself is Pi's.
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off", enabledModels: ["test/*"],
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
  }));
  const model = (provider) => ({ api: "openai-completions", baseUrl: `http://127.0.0.1:${http.address().port}/v1`,
    apiKey: "fake-key", models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000,
      maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: model("test"), broken: model("broken") } }));

  // 1. Compact status carries the last five calls with short arguments; verbose carries all.
  let host = await connect({ TEST_BROKEN_PROVIDER: "broken" });
  await host.call("spawn", { cwd: directory, id: "many", prompt: "MANY_CALLS", tools: ["ls"], durable: false });
  const compact = await settle(host, "many");
  assert.equal(compact.toolCallCount, 7);
  assert.equal(compact.toolCalls.length, 5);
  assert.deepEqual(compact.toolCalls.map((c) => c.seq), [3, 4, 5, 6, 7], "the most recent calls");
  assert.ok(compact.toolCalls.every((c) => c.args.length <= 121), "arguments are shortened");
  const full = await host.call("status", { sessionId: "many", verbose: true });
  assert.equal(full.toolCalls.length, 7);
  assert.ok(full.toolCalls[0].args.length > 121);
  const waited = await host.call("wait", { sessionId: "many", timeoutMs: 250 });
  assert.equal(waited.toolCalls.length, 5, "wait is compact too");

  // 1a. wait until settled returns once, with the result, instead of on every tool call.
  await host.call("spawn", { cwd: directory, id: "many-settled", prompt: "MANY_CALLS PACED", tools: ["ls"] });
  const settledOnce = await host.call("wait", { sessionId: "many-settled", until: "settled", timeoutMs: 15000 });
  assert.equal(settledOnce.state, "done", "one wait call reaches the end");
  assert.equal(settledOnce.toolCallCount, 7);

  // 1aa. Several sessions: returns when one settles, with its answer; the others stay pending.
  await host.call("spawn", { cwd: directory, id: "quick", prompt: "plain", tools: [] });
  await host.call("spawn", { cwd: directory, id: "slow", prompt: "SLOW plain", tools: [] });
  const first = await host.call("wait", { sessionIds: ["quick", "slow"], timeoutMs: 15000 });
  assert.deepEqual(first.settled, ["quick"]);
  assert.deepEqual(first.pending, ["slow"]);
  assert.equal(first.sessions.find((x) => x.sessionId === "quick").lastText, "OK", "finished ones carry the answer");
  assert.equal(first.sessions.find((x) => x.sessionId === "slow").lastText, undefined, "running ones do not");
  const all = await host.call("wait", { sessionIds: ["quick", "slow"], until: "all_settled", timeoutMs: 15000 });
  assert.deepEqual(all.settled.sort(), ["quick", "slow"]);
  assert.deepEqual(all.pending, []);
  await assert.rejects(() => host.call("wait", { sessionId: "quick", sessionIds: ["slow"] }), /exactly one/);
  // spawn_batch hands back the ids to wait on and says how; steer on a finished one points to follow_up;
  // models says which model a spawn without one gets.
  const batch = await host.call("spawn_batch", { cwd: directory, idPrefix: "fan", tools: [], tasks: [{ prompt: "plain" }, { prompt: "plain" }] });
  assert.deepEqual(batch.sessionIds, ["fan-01", "fan-02"]);
  assert.match(batch.next, /wait with these sessionIds/);
  assert.deepEqual((await host.call("wait", { sessionIds: batch.sessionIds, until: "all_settled", timeoutMs: 15000 })).pending, []);
  await assert.rejects(() => host.call("steer", { sessionId: "fan-01", message: "x" }), /Use follow_up/);
  const listed = await host.call("models", { cwd: directory });
  assert.equal(listed.defaultModel, "test/one");
  assert.equal(listed.defaultUsable, true);
  await assert.rejects(() => host.call("wait", { sessionIds: ["slow"], until: "progress" }), /settled/);

  // 1b. Without durable, a delegate is in memory only.
  assert.equal(host.init.durability.default, false);
  await host.call("spawn", { cwd: directory, id: "plain-default", prompt: "plain", tools: [] });
  const plain = await settle(host, "plain-default");
  assert.equal(plain.durable, false);
  assert.equal(plain.retentionDays, undefined);
  assert.equal((await host.call("sessions")).stored.length, 0, "nothing stored");
  await assert.rejects(() => host.call("spawn", { cwd: directory, id: "keep", prompt: "plain", tools: [], retentionDays: 30 }),
    /retentionDays applies only to durable delegates/);

  // 1c. The wall-clock limit applies per run: a session finished long ago can still be followed up.
  await host.call("spawn", { cwd: directory, id: "short-clock", prompt: "plain", tools: [], maxDurationMs: 1000 });
  await settle(host, "short-clock");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await host.call("follow_up", { sessionId: "short-clock", prompt: "again" });
  const second = await settle(host, "short-clock");
  assert.equal(second.state, "done");
  assert.equal(second.turns, 2);

  // 2. A provider whose credentials fail is reported by init, not offered, and refused at spawn.
  assert.match(host.init.failingProviders.broken, /OAuth refresh failed/);
  assert.ok(!JSON.stringify(host.init.models).includes("broken/one"), "its models are not offered");
  await assert.rejects(() => host.call("spawn", { cwd: directory, id: "nope", prompt: "x", model: "broken/one", tools: [] }),
    /Provider broken is not usable right now/);
  assert.equal((await host.call("sessions")).sessions.some((s) => s.sessionId === "nope"), false, "nothing was started");

  // 3. Pi's automatic retries are visible, and the final error says they were used up.
  await host.call("spawn", { cwd: directory, id: "flaky", prompt: "FAIL503", tools: [], durable: false });
  const failed = await settle(host, "flaky");
  assert.equal(failed.state, "error");
  assert.match(failed.error, /after 2 automatic retries/);
  assert.ok(failed.notices.some((n) => /provider retry 1\/2/.test(n.message)));
  await close(host);

  // 4. grep finds ripgrep in Pi's tool directory when PATH has none, and explains itself otherwise.
  const noRgPath = join(directory, "empty-path");
  await mkdir(noRgPath);
  host = await connect({ PATH: noRgPath });
  assert.match(host.init.search.ripgrep, /was not found/);
  await host.call("spawn", { cwd: directory, id: "grep-missing", prompt: "GREP", tools: ["grep"], durable: false });
  await settle(host, "grep-missing");
  const missing = await host.call("status", { sessionId: "grep-missing", verbose: true });
  assert.equal(missing.toolCalls[0].state, "error");
  assert.match(missing.toolCalls[0].result, /ripgrep \(rg\) was not found/);
  await close(host);
  const real = spawnSync("rg", ["--version"]).error ? undefined : execFileSync("sh", ["-c", "command -v rg"]).toString().trim();
  if (real) {
    await symlink(real, join(agentDir, "bin", "rg"));
    host = await connect({ PATH: noRgPath });
    assert.equal(host.init.search.ripgrep, join(agentDir, "bin", "rg"));
    await host.call("spawn", { cwd: directory, id: "grep-local", prompt: "GREP", tools: ["grep"], durable: false });
    await settle(host, "grep-local");
    const found = await host.call("status", { sessionId: "grep-local", verbose: true });
    assert.equal(found.toolCalls[0].state, "ok");
    assert.match(found.toolCalls[0].result, /needle/);
    await close(host);
  } else console.log("  (no rg on PATH: skipped the Pi tool-directory case)");
  console.log("  OK -> compact status/wait, failing provider reported and refused, retries visible, ripgrep from Pi's tool directory");
} finally {
  for (const host of clients) await host.client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
