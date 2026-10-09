import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

process.env.PI_DELEGATE_PROGRESS_MS = "10";
const core = await import("../dist/core.js");
const registry = await import("../dist/registry.js");
const { PiWorker } = await import("../dist/pi/worker.js");
const { Question } = await import("../dist/pi/ui.js");
const { createServer } = await import("../dist/server.js");
const { cleanup } = await import("../dist/statusline/state.js");
const dir = await mkdtemp(join(tmpdir(), "pi-core-"));
const originalStart = PiWorker.prototype.start;
const runs = new Map();
const server = createServer();
const client = new Client({ name: "core-adapter", version: "1" });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
// Keep the real worker lifecycle; only replace the SDK session with controllable prompts.
PiWorker.prototype.start = async function (prompt) {
  if (this.isStopped()) return this; // as the real start does at each step
  const steering = [];
  this.session = {
    prompt: async (text) => {
      const run = Promise.withResolvers();
      runs.set(this.id, run);
      this.onEvent({ type: "turn_start" });
      if (text === "edit-instant") {
        this.onEvent({ type: "tool_execution_start", toolCallId: "written", toolName: "write", args: { path: "receipt.txt" } });
        this.onEvent({ type: "tool_execution_end", toolCallId: "written", toolName: "write", isError: false, result: { content: [] } });
        this.lastText = "wrote receipt.txt"; run.resolve();
      }
      if (text === "instant") { this.lastText = "instant result"; run.resolve(); }
      await run.promise;
    },
    waitForIdle: async () => {},
    steer: async (text) => { steering.push(text); },
    getSteeringMessages: () => steering,
    abort: async () => { runs.get(this.id).resolve(); },
    dispose: () => {},
  };
  void this.track(this.session, prompt);
  if (prompt === "instant" || prompt === "edit-instant") await this.run;
  return this;
};
const raw = (name, args = {}) => client.callTool({ name, arguments: args });
const call = async (name, args = {}) => {
  const response = await raw(name, args);
  assert.ok(!response.isError, response.content[0].text);
  return JSON.parse(response.content[0].text);
};
try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  assert.equal((await call("sessions")).count, 0, "tools work without an init call");

  const instant = await call("spawn", { cwd: dir, id: "instant", prompt: "instant", tools: [] });
  assert.equal(instant.state, "done");
  assert.equal(instant.nextAction, "wait", "start responses still need result collection if work finished immediately");
  const instantResult = await call("wait", { sessionId: instant.sessionId });
  assert.equal(instantResult.lastText, "instant result");
  assert.equal(instantResult.nextAction, "finish");
  const instantFollow = await call("follow_up", { sessionId: instant.sessionId, prompt: "instant" });
  assert.equal(instantFollow.nextAction, "wait");
  await call("forget", { sessionId: instant.sessionId });

  const edited = await call("run", { cwd: dir, id: "edit-result", prompt: "edit-instant", tools: [] });
  const collected = await call("wait", { sessionId: edited.sessionId, until: "settled" });
  const batchCollected = await call("wait", { sessionIds: [edited.sessionId], until: "all_settled" });
  for (const result of [edited, collected, batchCollected.sessions[0], await call("status", { sessionId: edited.sessionId })]) {
    assert.deepEqual(result.touchedFiles, ["receipt.txt"]);
    assert.equal(result.editWriteCount, 1);
  }
  await call("forget", { sessionId: edited.sessionId });

  const started = await core.startExecution({ cwd: dir, id: "core-start", prompt: "work", tools: [] });
  const w = registry.loaded(started.sessionId);
  w.lastText = "old partial narrative";
  const noticeAt = new Date().toISOString();
  const info = { type: "info", message: "ordinary update", at: noticeAt };
  const warning = { type: "warning", message: "provider retry is visible", at: noticeAt };
  const error = { type: "error", message: "extension failure is visible", at: noticeAt };
  const custom = { type: "custom", message: "unknown notice types are preserved", at: noticeAt };
  w.notices.push(info, warning, error, custom);
  assert.equal((await call("status", { sessionId: w.id })).state, "running");
  assert.equal((await call("status", { sessionId: w.id })).nextAction, "wait");
  assert.equal((await call("wait", { sessionId: w.id, afterTurns: 0 })).nextAction, "wait");
  const briefWait = await call("wait", { sessionId: w.id, afterTurns: 0 });
  assert.equal("lastText" in briefWait, false, "running waits do not repeat partial prose");
  assert.deepEqual(briefWait.notices, [warning, error, custom]);
  assert.equal(briefWait.toolCallCount, 0);
  assert.equal(briefWait.phase, (await core.getState(w.id)).phase, "liveness remains visible");
  const detailedWait = await call("wait", { sessionId: w.id, afterTurns: 0, verbose: true });
  assert.equal(detailedWait.lastText, w.lastText);
  assert.deepEqual(detailedWait.notices, w.notices);
  const diagnosticState = await call("status", { sessionId: w.id });
  assert.equal(diagnosticState.lastText, w.lastText);
  assert.deepEqual(diagnosticState.notices, w.notices, "status stays diagnostic");
  assert.equal("nextAction" in await core.getState(w.id), false, "caller advice stays in the MCP adapter");
  assert.equal((await call("steer", { sessionId: w.id, message: "focus" })).queued, 1);
  assert.deepEqual(w.session.getSteeringMessages(), ["focus"]);
  const q = new Question("confirm", "continue?");
  w.questions.set(q.id, q);
  assert.equal((await core.getState(w.id)).questions[0].id, q.id);
  const questionSnapshot = await call("wait", { sessionId: w.id, timeoutMs: 1000 });
  assert.equal(questionSnapshot.questions[0].id, q.id);
  assert.equal(questionSnapshot.nextAction, "answer");
  assert.equal("lastText" in questionSnapshot, false);
  assert.deepEqual(questionSnapshot.notices, [warning, error, custom]);
  assert.equal((await call("status", { sessionId: w.id })).nextAction, "answer");
  assert.equal(w.questions.has(q.id), true, "wait observes the question without answering");
  await call("answer", { sessionId: w.id, requestId: q.id, value: true });
  assert.equal(await q.promise, true);
  assert.equal((await core.getState(w.id)).questions.length, 0);

  const cancelledWait = new AbortController();
  const waiting = core.waitForState(w.id, { timeoutMs: 1000, signal: cancelledWait.signal });
  cancelledWait.abort();
  assert.equal((await waiting).state, "running");
  assert.equal(w.isActive, true);
  assert.equal((await raw("forget", { sessionId: w.id })).isError, true);
  runs.get(w.id).resolve();
  await w.run;
  const finalWait = await call("wait", { sessionId: w.id, timeoutMs: 250 });
  assert.equal(finalWait.state, "done");
  assert.equal(finalWait.lastText, w.lastText, "terminal answers remain intact");
  assert.deepEqual(finalWait.notices, w.notices, "terminal waits retain info notices too");
  assert.equal((await call("status", { sessionId: w.id })).nextAction, "finish");
  const turnsBefore = w.turns;
  await call("follow_up", { sessionId: w.id, prompt: "another run" });
  assert.equal(registry.loaded(w.id), w, "follow-up reuses the conversation's worker");
  assert.equal((await core.getState(w.id)).turns, turnsBefore + 1);
  await core.cancelExecution(w.id);
  await w.run;
  assert.equal((await call("status", { sessionId: w.id })).termination.reason, "manual_abort");
  const abortedWait = await call("wait", { sessionId: w.id, until: "settled" });
  assert.equal(abortedWait.nextAction, "finish");
  assert.equal(abortedWait.state, "aborted");
  assert.equal(abortedWait.termination.reason, "manual_abort");
  await call("forget", { sessionId: w.id });
  await assert.rejects(() => core.getState(w.id), /Unknown sessionId/);

  const fromMcp = await call("spawn", { cwd: dir, id: "mcp-start", prompt: "work", tools: [] });
  assert.equal((await core.getState(fromMcp.sessionId)).state, "running");
  assert.equal(core.listSessions("running").sessions[0].sessionId, fromMcp.sessionId);
  assert.deepEqual(core.listSessions().sessions[0].limits, fromMcp.limits);
  await call("abort", { sessionId: fromMcp.sessionId });
  await registry.loaded(fromMcp.sessionId).run;
  await core.forgetSession(fromMcp.sessionId);
  assert.equal((await raw("status", { sessionId: fromMcp.sessionId })).isError, true);

  // Sync throws and async rejections do not affect execution; progress stops on completion.
  let notifications = 0;
  const firstProgress = Promise.withResolvers();
  const running = core.runExecution({ cwd: dir, id: "progress", prompt: "work", tools: [] }, {
    onProgress: (progress) => {
      assert.equal(progress.state, "running");
      notifications++;
      if (notifications === 1) throw new Error("synchronous sink failure");
      firstProgress.resolve();
      return Promise.reject(new Error("notification transport closed"));
    },
  });
  await firstProgress.promise;
  runs.get("progress").resolve();
  assert.equal((await running).state, "done");
  const countAtFinish = notifications;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(notifications, countAtFinish);

  // Exercise the MCP closure too: preserve the caller's token and forward cancellation.
  const progressMessages = [];
  const mcpProgress = Promise.withResolvers();
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
    progressMessages.push(notification.params);
    mcpProgress.resolve();
  });
  const mcpCaller = new AbortController();
  const mcpRun = client.callTool({ name: "run", arguments: {
    cwd: dir, id: "mcp-run", prompt: "work", tools: [],
  }, _meta: { progressToken: "phase1-progress" } }, undefined, { signal: mcpCaller.signal });
  const rejectedRun = assert.rejects(mcpRun, /abort/i);
  await mcpProgress.promise;
  assert.deepEqual(progressMessages[0], {
    progressToken: "phase1-progress", progress: 1, message: "running, turn 1",
  });
  mcpCaller.abort();
  await rejectedRun;
  const mcpCancelled = await core.waitForState("mcp-run", { timeoutMs: 1000 });
  assert.equal(mcpCancelled.state, "aborted");
  assert.equal(mcpCancelled.termination.reason, "caller_cancelled");
  await registry.loaded("mcp-run").run;
  const progressAtCancel = progressMessages.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(progressMessages.length, progressAtCancel, "MCP progress stops after cancellation");

  // An already-cancelled caller still cancels a blocking run, preserving its reason.
  const caller = new AbortController();
  caller.abort();
  const cancelled = await core.runExecution({ cwd: dir, id: "cancelled", prompt: "work", tools: [] }, { signal: caller.signal });
  assert.equal(cancelled.state, "aborted");
  assert.equal(cancelled.termination.reason, "caller_cancelled");
  assert.equal(runs.has(cancelled.sessionId), false, "a run cancelled before it began never prompts Pi");
  // A batch member waiting for an answer stays in the set the caller keeps waiting on.
  const asker = await core.startExecution({ cwd: dir, id: "batch-asker", prompt: "work", tools: [] });
  const quiet = await core.startExecution({ cwd: dir, id: "batch-quiet", prompt: "work", tools: [] });
  const quietWorker = registry.loaded(quiet.sessionId);
  quietWorker.lastText = "still working";
  const batchAt = new Date().toISOString();
  const batchInfo = { type: "info", message: "ordinary batch update", at: batchAt };
  const batchWarning = { type: "warning", message: "batch warning", at: batchAt };
  const batchError = { type: "error", message: "batch error", at: batchAt };
  quietWorker.notices.push(batchInfo, batchWarning, batchError);
  const ask = new Question("confirm", "continue?");
  registry.loaded(asker.sessionId).questions.set(ask.id, ask);
  const seenBatch = await call("wait", { sessionIds: [asker.sessionId, quiet.sessionId], timeoutMs: 1000 });
  assert.deepEqual(seenBatch.settled, [asker.sessionId], "a question settles the wait");
  assert.equal(seenBatch.nextAction, "answer");
  assert.equal(seenBatch.sessions.find((s) => s.sessionId === quiet.sessionId).nextAction, "wait");
  assert.deepEqual(seenBatch.sessions.find((s) => s.sessionId === quiet.sessionId).notices, [batchWarning, batchError]);
  assert.equal("lastText" in seenBatch.sessions.find((s) => s.sessionId === quiet.sessionId), false);
  assert.equal(seenBatch.sessions.find((s) => s.sessionId === asker.sessionId).nextAction, "answer");
  assert.deepEqual(seenBatch.continueIds?.sort(), [asker.sessionId, quiet.sessionId].sort(),
    "both still need waiting on after the answer");
  assert.equal(seenBatch.sessions.find((x) => x.sessionId === asker.sessionId).questions[0].id, ask.id);
  await call("answer", { sessionId: asker.sessionId, requestId: ask.id, value: true });
  for (const id of [asker.sessionId, quiet.sessionId]) { runs.get(id).resolve(); await registry.loaded(id).run; }
  const doneBatch = await call("wait", { sessionIds: seenBatch.continueIds, until: "all_settled", timeoutMs: 1000 });
  assert.deepEqual(doneBatch.continueIds, []);
  assert.equal(doneBatch.nextAction, "finish");
  assert.ok(doneBatch.sessions.every((s) => s.nextAction === "finish"));
  const quietDone = doneBatch.sessions.find((s) => s.sessionId === quiet.sessionId);
  assert.equal(quietDone.lastText, quietWorker.lastText);
  assert.deepEqual(quietDone.notices, quietWorker.notices);

  console.log("  OK -> core/custom MCP shared state, follow-up, interaction, cancel vs wait, progress cleanup");
} finally {
  for (const w of registry.all()) {
    if (w.isActive) { await w.abort(); await w.run; }
    await core.forgetSession(w.id);
  }
  PiWorker.prototype.start = originalStart;
  await client.close();
  await server.close();
  cleanup();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
