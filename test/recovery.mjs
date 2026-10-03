import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const directory = await mkdtemp(join(tmpdir(), "pi-delegate-recovery-"));
const agentDir = join(directory, "agent");
const stateDir = join(directory, "state");
const requests = [];
const held = new Set();
const clients = new Set();
const sockets = new Set();
const savedTask = (id) => {
  const catalog = new DatabaseSync(join(stateDir, "durable", "v2", "catalog.sqlite"), { readOnly: true });
  try {
    const row = catalog.prepare("SELECT key FROM jobs WHERE json_extract(options, '$.id') = ?").get(id);
    const store = new DatabaseSync(join(stateDir, "durable", "v2", "jobs", row.key, "session.sqlite"), { readOnly: true });
    try { return JSON.parse(store.prepare("SELECT record FROM tasks ORDER BY id DESC LIMIT 1").get().record); }
    finally { store.close(); }
  } finally { catalog.close(); }
};
const waitUntil = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Recovery fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  const encoded = JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content);
  const recovering = encoded.includes("The MCP service restarted.");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "recovery-test", object: "chat.completion.chunk", created: 1, model: "one",
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  const tools = (calls) => {
    emit({ role: "assistant", tool_calls: calls.map(({ name, args, id }, index) => ({ index, id, type: "function", function: {
      name, arguments: JSON.stringify(args),
    } })) });
    emit({}, "tool_calls");
  };
  const tool = (name, args, id) => tools([{ name, args, id }]);
  if (encoded.includes("COMPLETE_EFFECT") && !recovering) {
    if (request.messages.some((m) => m.role === "tool")) { held.add("complete"); return; }
    tool("write", { path: join(directory, "output.txt"), content: "saved result" }, "complete-call");
  } else if (encoded.includes("UNKNOWN_EFFECT") && !recovering) {
    tool("effect", {}, "unknown-call");
  } else if (encoded.includes("PAUSE_EFFECT") && !recovering) {
    tools([{ name: "pause_effect", args: {}, id: "pause-call" }, { name: "later_effect", args: {}, id: "later-call" }]);
  } else if (encoded.includes("FOLLOW_RUNNING") && !recovering) {
    held.add("follow-up"); return;
  } else if (!recovering && ["GRACEFUL", "EXPLICIT_ABORT", "EXPIRED"].some((marker) => encoded.includes(marker))) {
    held.add(encoded.includes("GRACEFUL") ? "graceful" : encoded.includes("EXPIRED") ? "expired" : "abort");
    return;
  } else {
    emit({ role: "assistant", content: "RECOVERED_OK" });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const connect = async (hooks = {}) => {
  const client = new Client({ name: "recovery-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["test/recovery-server.mjs"],
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: stateDir,
      PI_DELEGATE_ALLOW_WRITE: "1", PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", ...hooks } });
  const host = { client, transport };
  clients.add(host);
  await client.connect(transport);
  const call = async (name, args = {}) => {
    // These tests exercise durability, which is opt-in for new delegates.
    if ((name === "spawn" || name === "run") && args.durable === undefined) args = { ...args, durable: true };
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  await call("init", { cwd: directory });
  host.call = call;
  return host;
};
const kill = async (host) => {
  process.kill(host.transport.pid, "SIGKILL");
  await waitUntil(() => { try { process.kill(host.transport.pid, 0); return false; } catch { return true; } });
  await host.client.close(); clients.delete(host);
};
const finish = async (host, id) => {
  let status;
  await waitUntil(async () => {
    status = await host.call("status", { sessionId: id, verbose: true });
    return !["starting", "running"].includes(status.state);
  });
  return status;
};

try {
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off", enabledModels: ["test/*"],
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000,
      maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(join(agentDir, "extensions", "effect.ts"), `
    import { appendFileSync } from "node:fs";
    export default function(pi) { pi.registerTool({ name: "effect", label: "Effect", description: "Recovery fixture",
      parameters: { type: "object", properties: {} },
      async execute(id, args, signal) {
        appendFileSync(${JSON.stringify(join(directory, "effects.txt"))}, "effect\\n");
        await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), {once:true}));
        return { content: [{type:"text", text:"effect done"}], details: {} };
      } }); }
  `);
  await writeFile(join(agentDir, "extensions", "pause-effect.ts"), `
    import { appendFileSync } from "node:fs";
    export default function(pi) {
      pi.registerTool({ name: "pause_effect", label: "Pause effect", description: "Pause fixture", executionMode: "sequential",
        parameters: { type: "object", properties: {} }, async execute(id, args, signal) {
          appendFileSync(${JSON.stringify(join(directory, "pause-effects.txt"))}, "started\\n");
          await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, {once:true}); });
          return {content:[{type:"text", text:"PAUSE_COMPLETED"}], details:{}};
        } });
      pi.registerTool({ name: "later_effect", label: "Later effect", description: "Must not run after pause",
        parameters: { type: "object", properties: {} }, async execute() {
          appendFileSync(${JSON.stringify(join(directory, "pause-effects.txt"))}, "UNEXPECTED\\n");
          return {content:[{type:"text",text:"later"}],details:{}};
        } });
    }
  `);
  let host = await connect();
  await host.call("spawn", { cwd: directory, id: "complete", prompt: "COMPLETE_EFFECT", tools: ["write"], maxTurns: 8 });
  await waitUntil(() => held.has("complete"));
  const before = await host.call("status", { sessionId: "complete" });
  assert.deepEqual(savedTask("complete").state.checkpoint.results, {}, "results already in transcript are no longer duplicated");
  await kill(host);
  host = await connect();
  const restored = await finish(host, "complete");
  assert.equal(restored.state, "done");
  assert.equal(restored.lastText, "RECOVERED_OK");
  assert.equal(restored.startedAt, before.startedAt);
  assert.ok(restored.turns > before.turns, `turn budget is cumulative: before=${JSON.stringify(before)} after=${JSON.stringify(restored)}`);
  assert.equal(restored.toolCalls.length, 1);
  assert.equal(await readFile(join(directory, "output.txt"), "utf8"), "saved result");
  assert.ok(requests.findLast((r) => JSON.stringify(r.messages).includes("COMPLETE_EFFECT"))
    .messages.some((m) => m.role === "tool" && m.tool_call_id === "complete-call"));

  await host.call("spawn", { cwd: directory, id: "unknown", prompt: "UNKNOWN_EFFECT", tools: ["effect"], extensions: true });
  await waitUntil(async () => { try { return (await readFile(join(directory, "effects.txt"), "utf8")) === "effect\n"; } catch { return false; } });
  await kill(host);
  const racers = await Promise.all([connect(), connect()]);
  const ownership = await Promise.all(racers.map((candidate) => candidate.call("sessions")));
  const owners = ownership.map((result, i) => result.sessions.some((session) => session.sessionId === "unknown") ? i : -1)
    .filter((i) => i >= 0);
  assert.equal(owners.length, 1, "a dead worker is claimed by exactly one process");
  host = racers[owners[0]];
  const loser = racers[1 - owners[0]];
  await loser.client.close(); clients.delete(loser);
  assert.equal((await finish(host, "unknown")).state, "done");
  assert.equal(await readFile(join(directory, "effects.txt"), "utf8"), "effect\n", "interrupted effect was not replayed");
  const unknownRequest = requests.findLast((r) => JSON.stringify(r.messages).includes("UNKNOWN_EFFECT"));
  assert.match(JSON.stringify(unknownRequest.messages.find((m) => m.role === "tool").content), /outcome is unknown/);

  // Live owners must not be stolen, even by another client using exactly the same state directory.
  await host.call("spawn", { cwd: directory, id: "graceful", prompt: "GRACEFUL", tools: [] });
  await waitUntil(() => held.has("graceful"));
  await host.call("steer", { sessionId: "graceful", message: "PERSISTED_STEER" });
  const second = await connect();
  assert.equal((await second.call("sessions")).count, 0);
  await second.client.close(); clients.delete(second);
  await host.client.close(); clients.delete(host);
  // Crash again immediately after the recovery turn_start checkpoint, before the
  // recovery input's user message lands. Accepted steering must survive both crashes.
  const recoveryCrash = join(directory, "recovery-crash.json");
  await assert.rejects(() => connect({ TEST_RECOVERY_CRASH: recoveryCrash }));
  assert.equal(JSON.parse(await readFile(recoveryCrash, "utf8")).steering[0], "PERSISTED_STEER");
  host = await connect();
  assert.equal((await finish(host, "graceful")).state, "done");
  assert.ok(requests.some((request) => JSON.stringify(request.messages).includes("GRACEFUL") &&
    JSON.stringify(request.messages).includes("PERSISTED_STEER")), "pending steering survives a restart");

  await host.call("spawn", { cwd: directory, id: "abort", prompt: "EXPLICIT_ABORT", tools: [] });
  await waitUntil(() => held.has("abort"));
  await host.call("abort", { sessionId: "abort" });
  const countAfterAbort = requests.length;
  await kill(host);
  host = await connect();
  const aborted = await finish(host, "abort");
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.termination.reason, "manual_abort");
  assert.equal(requests.length, countAfterAbort, "manual abort never resumes");

  await host.call("spawn", { cwd: directory, id: "expired", prompt: "EXPIRED", tools: [], maxDurationMs: 1000 });
  await waitUntil(() => held.has("expired"));
  await kill(host);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const countBeforeExpiry = requests.length;
  host = await connect();
  const expired = await finish(host, "expired");
  assert.equal(expired.state, "aborted");
  assert.equal(expired.termination.reason, "deadline");
  assert.equal(requests.length, countBeforeExpiry, "downtime counts toward the original deadline");

  await host.call("forget", { sessionId: "complete" });
  await host.client.close(); clients.delete(host);
  host = await connect();
  const listed = await host.call("sessions");
  assert.ok(!listed.sessions.some((s) => s.sessionId === "complete"), "forgotten jobs stay forgotten");
  await host.call("follow_up", { sessionId: "unknown", prompt: "Follow up on saved history" });
  const completedFollowUp = await finish(host, "unknown");
  assert.equal(completedFollowUp.state, "done");
  await waitUntil(() => savedTask("unknown").state.status === "terminal");
  const currentTaskId = savedTask("unknown").id;
  await kill(host);
  host = await connect();
  assert.equal((await finish(host, "unknown")).turns, completedFollowUp.turns, "completed follow-up is the current task after restart");
  assert.equal(savedTask("unknown").id, currentTaskId, "completed follow-up is not relaunched");
  await host.call("follow_up", { sessionId: "unknown", prompt: "FOLLOW_RUNNING" });
  await waitUntil(() => held.has("follow-up"));
  const runningFollowUp = await host.call("status", { sessionId: "unknown" });
  await kill(host);
  host = await connect();
  const resumedFollowUp = await finish(host, "unknown");
  assert.ok(resumedFollowUp.turns > runningFollowUp.turns);
  assert.ok(JSON.stringify(requests.at(-1).messages).includes("FOLLOW_RUNNING"), "unfinished follow-up retains its latest input");
  await host.client.close(); clients.delete(host);

  const barrier = join(directory, "tool-barrier");
  host = await connect({ TEST_TOOL_BARRIER: barrier });
  await host.call("spawn", { cwd: directory, id: "pause-effect", prompt: "PAUSE_EFFECT",
    tools: ["pause_effect", "later_effect"], extensions: true });
  await waitUntil(() => existsSync(barrier + ".started"));
  assert.equal(existsSync(join(directory, "pause-effects.txt")), false, "tool must await its asynchronous checkpoint callback");
  await writeFile(barrier + ".release", "release");
  await waitUntil(() => existsSync(join(directory, "pause-effects.txt")));
  await host.client.close(); clients.delete(host);
  assert.equal(await readFile(join(directory, "pause-effects.txt"), "utf8"), "started\n", "pause prevents subsequent tools");
  host = await connect();
  assert.equal((await finish(host, "pause-effect")).state, "done");
  const pauseRequest = requests.findLast((r) => JSON.stringify(r.messages).includes("PAUSE_EFFECT"));
  assert.match(JSON.stringify(pauseRequest.messages.find((m) => m.role === "tool" && m.tool_call_id === "pause-call")), /PAUSE_COMPLETED/,
    "tools settling during pause retain their actual results");
  console.log("  OK -> crash/recovery, follow-up before and after completion, second crash before steer admission, pause tool results, and awaited tool-start barrier");
} finally {
  for (const host of clients) await host.client.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
