import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const dir = await mkdtemp(join(tmpdir(), "pi-wait-finalization-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"),
  PI_DELEGATE_STATE_DIR: join(dir, "state") });
await mkdir(join(dir, "agent"));
const core = await import("../dist/core.js");
const registry = await import("../dist/registry.js");
const { PiWorker } = await import("../dist/pi/worker.js");
const { DurableJob } = await import("../dist/durable.js");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { cleanup } = await import("../dist/statusline/state.js");
const { createServer } = await import("../dist/server.js");
const server = createServer();
const client = new Client({ name: "finalization-adapter", version: "1" });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
};
const originalStart = PiWorker.prototype.start;
const entered = Promise.withResolvers(), release = Promise.withResolvers();
let worker;
PiWorker.prototype.start = async function (prompt) {
  worker = this;
  this.session = { sessionManager: SessionManager.inMemory(dir), messages: [],
    prompt: async () => { this.lastText = "answer"; }, waitForIdle: async () => {},
    abort: async () => {}, dispose: () => {} };
  this.job = await DurableJob.open(this.options, prompt);
  const begin = this.job.begin.bind(this.job);
  let first = true;
  // The SDK has finished, but the real durable task cannot commit its result yet.
  this.job.begin = (input, checkpoint, execute, recover) => begin(input, checkpoint, async (...args) => {
    const result = await execute(...args);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return result;
  }, recover);
  await this.beginDurable(prompt);
  return this;
};
try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { sessionId } = await core.startExecution({ cwd: dir, id: "finishing", prompt: "work",
    durable: true, tools: [], maxTurns: 5, maxDurationMs: 60000 });
  await entered.promise;
  assert.equal(worker.state, "done");
  assert.equal(worker.isActive, true, "the terminal commit is still pending");
  assert.equal((await core.getState(sessionId)).state, "running", "status also waits for durable finalization");
  assert.equal((await call("status", { sessionId })).nextAction, "wait");
  for (const verbose of [false, true]) {
    const listed = await call("sessions", { verbose });
    assert.equal(listed.sessions[0].state, "running", "sessions waits for durable finalization too");
    assert.equal(listed.sessions[0].followUpBlockedReason, "finalizing");
    assert.equal((await call("sessions", { state: "running", verbose })).count, 1);
    assert.equal((await call("sessions", { state: "done", verbose })).count, 0);
  }
  assert.equal((await call("wait", { sessionId, until: "settled", timeoutMs: 250 })).nextAction, "wait");
  let returned = false;
  const waiting = core.waitForState(sessionId, { until: "settled", timeoutMs: 2000 })
    .then((result) => { returned = true; return result; });
  await new Promise(setImmediate);
  assert.equal(returned, false, "settled must wait for durable finalization");
  const timedOut = await core.waitForState(sessionId, { until: "settled", timeoutMs: 1 });
  assert.equal(timedOut.state, "running", "a timeout must not advertise a committed result");
  assert.equal(timedOut.canFollowUp, false);
  assert.equal(timedOut.followUpBlockedReason, "finalizing");
  const progress = await core.waitForProgress(worker, 1);
  assert.equal(progress.state, "running");
  const batch = await core.waitForMany([sessionId], { until: "all_settled", timeoutMs: 1 });
  assert.deepEqual(batch.settled, []);
  assert.deepEqual(batch.pending, [sessionId]);
  assert.deepEqual(batch.continueIds, [sessionId]);
  assert.equal(batch.sessions[0].state, "running");
  release.resolve();
  assert.equal((await waiting).state, "done");
  assert.equal((await call("status", { sessionId })).nextAction, "finish");
  assert.equal((await call("sessions", { state: "done" })).count, 1);
  assert.equal((await call("sessions", { state: "running" })).count, 0);
  await core.followUp(sessionId, "continue immediately");
  await worker.run;
  assert.equal(worker.state, "done");
  await core.forgetSession(sessionId);
  console.log("  OK -> wait only reports completion after durable finalization; immediate follow_up works");
} finally {
  release.resolve();
  if (worker) { await worker.run; if (registry.loaded(worker.id)) await core.forgetSession(worker.id); }
  PiWorker.prototype.start = originalStart;
  await client.close();
  await server.close();
  cleanup();
  await rm(dir, { recursive: true, force: true });
}
