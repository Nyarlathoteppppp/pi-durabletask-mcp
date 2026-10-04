import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiWorker } from "../dist/pi/worker.js";
import { Question } from "../dist/pi/ui.js";
import { pickTools } from "../dist/permissions.js";
import { createProtectedGrepTool } from "../dist/pi/search.js";
import * as registry from "../dist/registry.js";
import { publish, readAll, cleanup, STATE_DIR } from "../dist/statusline/state.js";

const dir = await mkdtemp(join(tmpdir(), "pi-delegate-regression-"));
const originalStart = PiWorker.prototype.start;
const clearWorkers = async () => {
  for (const w of registry.all()) {
    if (w.isActive) await w.abort();
    await registry.forget(w.id);
  }
};
try {
  assert.deepEqual(pickTools([]), []);
  assert.deepEqual(pickTools(), ["read", "grep", "find", "ls"]);
  assert.throws(() => pickTools(["bash"]), /blocked/);

  PiWorker.prototype.start = async function () { return this; };
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) =>
    registry.launch({ cwd: dir, id: `capacity-${i}`, prompt: "stub" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 4);
  assert.equal(registry.activeCount(), 4);
  await clearWorkers();

  const duplicate = await Promise.allSettled([0, 1].map(() =>
    registry.launch({ cwd: dir, id: "same-id", prompt: "stub" })));
  assert.equal(duplicate.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(registry.count(), 1);
  await clearWorkers();

  await registry.launch({ cwd: dir, id: "existing", prompt: "stub" });
  await assert.rejects(() => registry.launchBatch(Array.from({ length: 4 }, (_, i) =>
    ({ cwd: dir, id: `batch-${i}`, prompt: "stub" }))), /concurrency limit/);
  assert.equal(registry.count(), 1, "rejected batch starts nothing");
  await clearWorkers();
  await assert.rejects(() => registry.launchBatch([0, 1].map(() =>
    ({ cwd: dir, id: "batch-duplicate", prompt: "stub" }))), /reuses session id/);
  assert.equal(registry.count(), 0);

  const batchRace = await Promise.allSettled([
    registry.launchBatch(Array.from({ length: 4 }, (_, i) =>
      ({ cwd: dir, id: `reserved-${i}`, prompt: "stub" }))),
    registry.launch({ cwd: dir, id: "competing", prompt: "stub" }),
  ]);
  assert.equal(batchRace.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(registry.activeCount() <= 4);
  await clearWorkers();

  PiWorker.prototype.start = async function () { throw new Error("startup failure"); };
  await assert.rejects(() => registry.launch({ cwd: dir, id: "reusable", prompt: "stub" }), /startup failure/);
  assert.equal(registry.count(), 0);
  PiWorker.prototype.start = originalStart;

  const w = new PiWorker({ cwd: dir, tools: [], maxTurns: 10, maxDurationMs: 10000 });
  const msg = { role: "assistant", stopReason: "stop", content: [
    { type: "text", text: "first" }, { type: "thinking", thinking: "private" },
    { type: "text", text: "second" },
  ] };
  w.onEvent({ type: "message_update", message: msg, assistantMessageEvent: { type: "text_end", content: "second" } });
  assert.equal(w.lastText, "first\nsecond");
  w.onEvent({ type: "message_end", message: msg });
  assert.equal(w.lastText, "first\nsecond");
  w.track({ prompt: async () => { throw new Error("provider failed"); }, waitForIdle: async () => {} }, "followup");
  await w.run;
  assert.equal(w.state, "error");
  assert.equal(w.lastText, "", "failed followup must not return prior text");

  const q = new Question("confirm", "test approval");
  w.questions.set(q.id, q);
  let finishPrompt;
  let finishAbort;
  const prompt = new Promise((resolve) => { finishPrompt = resolve; });
  const abortReady = new Promise((resolve) => { finishAbort = resolve; });
  const session = { prompt: () => prompt, waitForIdle: async () => {},
    abort: async () => { await q.promise; await abortReady; finishPrompt(); } };
  w.session = session;
  w.track(session, "approval");
  const abort = w.abort();
  assert.equal(w.pendingQuestions().length, 0);
  assert.equal(w.isActive, true, "abort retains capacity until idle");
  assert.throws(() => w.followUp("too soon"), /Use `steer`/);
  finishAbort();
  await abort;
  await w.run;
  assert.equal(w.isActive, false);
  assert.equal(w.pendingQuestions().length, 0);

  await writeFile(join(dir, "public.txt"), "before\nTEST_MARKER public\nafter\n");
  await writeFile(join(dir, ".env"), "TEST_MARKER FAKE_SECRET_ENV\n");
  await mkdir(join(dir, ".ssh"));
  await writeFile(join(dir, ".ssh", "id_fake"), "TEST_MARKER FAKE_SECRET_SSH\n");
  await symlink(join(dir, ".env"), join(dir, "alias.txt"));
  const grep = createProtectedGrepTool(dir);
  const runGrep = (input, signal = new AbortController().signal) => grep.execute("test", input, signal, undefined, { cwd: dir });
  const result = await runGrep({ pattern: "TEST_MARKER", glob: "*", context: 1 });
  const output = result.content[0].text;
  assert.match(output, /public.txt:2: TEST_MARKER public/);
  assert.match(output, /before/);
  assert.match(output, /after/);
  assert.doesNotMatch(output, /FAKE_SECRET|\.env|id_fake/);
  await assert.rejects(() => runGrep({ pattern: "TEST_MARKER", path: ".env" }), /private credential path/);
  await assert.rejects(() => runGrep({ pattern: "TEST_MARKER", path: "alias.txt" }), /private credential path/);
  assert.match((await runGrep({ pattern: "not-present" })).content[0].text, /No matches/);
  await assert.rejects(() => runGrep({ pattern: "[" }), /ripgrep failed/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(() => runGrep({ pattern: "TEST_MARKER" }, cancelled.signal));
  const limited = await runGrep({ pattern: ".", limit: 1 });
  assert.equal(limited.details.matchLimitReached, 1);

  const stateWorker = { id: "state-test", cwd: dir, state: "done", turns: 1,
    questions: new Map(), startedAt: new Date().toISOString() };
  for (let i = 0; i < 3; i++) {
    stateWorker.turns = i;
    publish([stateWorker]);
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.equal(readAll().find((s) => s.pid === process.pid).sessions[0].turns, i);
    assert.equal((await readdir(STATE_DIR)).filter((name) => name.endsWith(".tmp")).length, 0);
  }
  console.log("  OK -> concurrent reservations, IDs, cancellation, complete output, no-tools, safe grep, state publication");
} finally {
  PiWorker.prototype.start = originalStart;
  await clearWorkers();
  cleanup();
  await rm(dir, { recursive: true, force: true });
}
