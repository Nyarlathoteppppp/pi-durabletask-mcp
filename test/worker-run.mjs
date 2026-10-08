import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const directory = await mkdtemp(join(tmpdir(), "pi-worker-run-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(directory, "agent"),
  PI_DELEGATE_STATE_DIR: join(directory, "state") });
await mkdir(join(directory, "agent"));
const { PiWorker } = await import("../dist/pi/worker.js");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { MemoryJob, DurableJob, forgetOwnedJob } = await import("../dist/durable.js");
const { owns } = await import("../dist/ownership.js");
const selected = process.argv[2];
const scenarios = [];
const scenario = (name, execute) => scenarios.push({ name, execute });
const worker = (id, durable = false) => new PiWorker({ id, cwd: directory, tools: [], durable, maxTurns: 20, maxDurationMs: 10000 });
const session = (w, prompt) => ({ sessionManager: SessionManager.inMemory(directory), messages: [],
  prompt: async () => prompt.promise, waitForIdle: async () => {}, abort: async () => { prompt.resolve(); }, dispose: () => {} });

scenario("creation-failure", async () => {
  for (const durable of [false, true]) {
    const w = worker(`creation-${durable}`, durable);
    const prompt = Promise.withResolvers();
    w.session = session(w, prompt);
    w.state = "done";
    w.lastText = "previous answer";
    w.notices.push({ type: "warning", message: "previous notice", at: new Date().toISOString() });
    w.turns = 20;
    w.job = durable ? await DurableJob.open(w.options, "previous") : new MemoryJob();
    w.job.begin = async () => { throw new Error("task creation failed"); };
    try {
      await assert.rejects(w.followUp("next", { maxTurns: 4, maxToolCalls: 3 }), /task creation failed/);
      assert.equal(w.state, "done");
      assert.equal(w.isActive, false, "failed task creation releases finalization activity");
      assert.equal(w.continuation.canFollowUp, false, "failed renewal cannot grant quota");
      assert.equal(w.maxTurns, 20);
      assert.equal(w.maxToolCalls, undefined);
      assert.deepEqual(w.snapshot().budgetStart, { turns: 0, toolCalls: 0 });
      assert.equal(w.lastText, "previous answer", "failed creation keeps the previous result");
      assert.deepEqual(w.snapshot().notices.map((n) => n.message), ["previous notice"], "refused follow-up keeps the previous run's notice boundary");
    } finally { w.dispose(); await w.job.forget(); }
  }
});

scenario("cancel-creation-failure", async () => {
  for (const durable of [false, true]) {
    const w = worker(`cancel-creation-${durable}`, durable);
    w.session = session(w, Promise.withResolvers());
    w.state = "done"; w.turns = 20; w.lastText = "previous answer";
    w.job = durable ? await DurableJob.open(w.options, "previous") : new MemoryJob();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let cancelled;
    w.job.save = async checkpoint => { cancelled = checkpoint; };
    w.job.begin = async (_prompt, checkpoint) => {
      assert.equal(checkpoint.snapshot.limits.maxTurns, 4, "staged task checkpoint contains requested quota");
      entered.resolve(); await release.promise; throw new Error("creation failed after cancellation");
    };
    const starting = w.followUp("next", { maxTurns: 4, maxToolCalls: 3 });
    const rejected = assert.rejects(starting, /creation failed after cancellation/);
    try {
      await entered.promise;
      await w.abort("caller_cancelled");
      release.resolve(); await rejected;
      assert.equal(w.state, "aborted", "creation refusal cannot override cancellation");
      assert.equal(w.termination.reason, "caller_cancelled");
      assert.equal(w.maxTurns, 20);
      assert.equal(w.maxToolCalls, undefined);
      assert.equal(cancelled.snapshot.limits.maxTurns, 20, "cancellation cannot save provisional quota to the previous task");
      assert.equal(cancelled.snapshot.limits.maxToolCalls, undefined);
      assert.deepEqual(cancelled.snapshot.budgetStart, { turns: 0, toolCalls: 0 });
      assert.equal(w.isActive, false);
    } finally { release.resolve(); await rejected; w.dispose(); await w.job.forget(); }
  }
});

scenario("legacy-budget", async () => {
  const w = worker("legacy-budget");
  w.session = session(w, Promise.withResolvers()); w.state = "done"; w.turns = 3;
  const saved = w.checkpoint();
  delete saved.snapshot.budgetStart;
  saved.snapshot.limits = { maxTurns: 5, maxDurationMs: 10000, maxToolCalls: 2 };
  w.restoreSnapshot(saved);
  assert.deepEqual(w.snapshot().budgetStart, { turns: 0, toolCalls: 0 });
  assert.equal(w.continuation.remainingTurns, 2, "old checkpoints keep cumulative budget semantics");
  assert.equal(w.maxToolCalls, 2);
  assert.throws(() => w.followUp("invalid", { maxTurns: 51 }), /maxTurns must/);
  assert.throws(() => w.followUp("invalid", { maxToolCalls: 0 }), /maxToolCalls must/);
  assert.equal(w.state, "done");
  w.dispose();
});

scenario("run-notices", async () => {
  const w = worker("run-notices");
  const prompt = Promise.withResolvers();
  w.session = session(w, prompt);
  w.job = new MemoryJob();
  w.state = "done";
  w.currentRun.startedAt = "2000-01-01T00:00:00.000Z";
  const old = { type: "warning", message: "old run budget", at: w.currentRun.startedAt };
  w.notices.push(old);
  try {
    await w.followUp("next");
    const current = { type: "info", message: "this run", at: w.currentRun.startedAt };
    w.notices.push(current);
    assert.deepEqual(w.snapshot().notices, [current], "include boundary notices, exclude previous run");
    assert.deepEqual(w.snapshot({ verbose: true }).notices, [old, current], "keep the full diagnostic history");
    const checkpoint = w.checkpoint();
    assert.deepEqual(checkpoint.snapshot.notices, [old, current]);
    w.restoreSnapshot(checkpoint);
    assert.deepEqual(w.snapshot().notices, [current], "recovery retains the original run boundary");
    delete checkpoint.snapshot.runStartedAt;
    checkpoint.snapshot.startedAt = old.at;
    w.restoreSnapshot(checkpoint);
    assert.deepEqual(w.snapshot().notices, [old, current], "legacy checkpoints preserve unscoped history");
  } finally { prompt.resolve(); await w.run; w.dispose(); await w.job.forget(); }
});

scenario("old-completion", async () => {
  const w = worker("completion");
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const firstSession = session(w, first), secondSession = session(w, second);
  w.session = firstSession;
  const old = w.track(firstSession, "first");
  w.session = secondSession;
  const current = w.track(secondSession, "second");
  try {
    first.resolve(); await old;
    assert.equal(w.state, "running", "old completion cannot finish the replacement run");
    assert.equal(w.run, current, "the observable promise belongs to the replacement run");
    second.resolve(); await current;
    assert.equal(w.state, "done");
  } finally { first.resolve(); second.resolve(); await Promise.all([old, current]); w.dispose(); }
});

scenario("old-timer", async () => {
  const w = worker("timer");
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const firstSession = session(w, first), secondSession = session(w, second);
  let aborts = 0;
  secondSession.abort = async () => { aborts++; second.resolve(); };
  const callbacks = [];
  const timeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay > 9000 && delay <= 10000) callbacks.push(() => callback(...args));
    return timeout(callback, delay, ...args);
  };
  let old, current;
  try {
    w.session = firstSession; old = w.track(firstSession, "first");
    w.session = secondSession; current = w.track(secondSession, "second");
    assert.equal(callbacks.length, 2);
    callbacks[0](); // A callback already dispatched before its timer was cleared.
    await new Promise(setImmediate);
    assert.equal(aborts, 0, "the prior deadline cannot abort the replacement SDK run");
    assert.equal(w.state, "running");
  } finally {
    globalThis.setTimeout = timeout;
    first.resolve(); second.resolve(); await Promise.all([old, current]); w.dispose();
  }
});

scenario("cancel-write-failure", async () => {
  const w = worker("cancel");
  const write = Promise.withResolvers(), idle = Promise.withResolvers(), entered = Promise.withResolvers();
  const prompt = Promise.withResolvers();
  w.session = session(w, prompt);
  w.session.abort = async () => { entered.resolve(); await idle.promise; };
  w.job = new MemoryJob();
  w.job.save = () => write.promise;
  w.state = "running";
  const cancelling = w.abort("caller_cancelled");
  const rejected = assert.rejects(cancelling, /checkpoint write failed/);
  try {
    assert.equal(w.isActive, true, "cancellation owns its slot while checkpointing");
    assert.throws(() => w.followUp("too soon"), /still working/);
    write.reject(new Error("checkpoint write failed"));
    await entered.promise;
    assert.equal(w.isActive, true, "a failed checkpoint must still drain SDK cancellation");
    idle.resolve(); await rejected;
    assert.equal(w.state, "aborted");
    assert.equal(w.isActive, false);
  } finally { write.reject(new Error("checkpoint write failed")); idle.resolve(); await rejected; w.dispose(); }
});

scenario("final-write-failure", async () => {
  const w = worker("final-write");
  w.session = session(w, Promise.withResolvers());
  w.session.prompt = async () => { w.lastText = "answer"; };
  w.job = new MemoryJob();
  w.job.recordFinal = () => { throw new Error("catalog write failed"); };
  try {
    await w.beginDurable("work");
    await assert.doesNotReject(w.run, "completion remains awaitable after final-result persistence fails");
    assert.equal(w.state, "error");
    assert.match(w.error, /catalog write failed/);
    assert.equal(w.lastText, "answer");
    assert.equal(w.isActive, false);
  } finally { w.dispose(); }
});

scenario("budget-write-failure", async () => {
  const w = worker("budget-write");
  w.session = session(w, Promise.withResolvers());
  w.job = new MemoryJob();
  w.job.save = async () => { throw new Error("checkpoint write failed"); };
  w.state = "running";
  try {
    w.abortForBudget("deadline", { limit: 10000, observed: 10000 });
    await new Promise(setImmediate);
    assert.equal(w.state, "aborted");
    assert.equal(w.isActive, false);
    assert.match(w.notices.at(-1).message, /checkpoint write failed/);
  } finally { w.dispose(); }
});

scenario("concurrent-close", async () => {
  const w = worker("concurrent-close", true);
  const job = await DurableJob.open(w.options, "work");
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const close = job.harness.close.bind(job.harness);
  job.harness.close = async (...args) => { entered.resolve(); await release.promise; return close(...args); };
  let first, second;
  try {
    first = job.close(false);
    second = job.close(false);
    let settled = false;
    second.then(() => { settled = true; });
    await entered.promise;
    await new Promise(setImmediate);
    assert.equal(settled, false, "another close awaits the actual Harness shutdown");
    release.resolve();
    await Promise.all([first, second]);
  } finally { release.resolve(); await Promise.all([first, second]); forgetOwnedJob(job.key); }
});

scenario("steer-before-recovered-answer", async () => {
  for (const stopReason of ["stop", "length"]) {
    const w = worker(`recovered-answer-${stopReason}`);
    const prompts = [];
    w.session = session(w, Promise.withResolvers());
    w.session.messages = [{ role: "assistant", stopReason, content: [{ type: "text", text: "old answer" }] }];
    w.session.prompt = async (text) => { prompts.push(text); w.lastText = "updated answer"; };
    w.inputStarted = true;
    w.state = "running";
    w.lastText = "old answer";
    const saved = w.checkpoint();
    w.job = new MemoryJob();
    const begin = w.job.begin.bind(w.job);
    w.job.begin = async (...args) => { w.steering.push("accepted while reopening"); return begin(...args); };
    try {
      await w.beginDurable("resume", saved, true);
      await w.run;
      assert.equal(prompts.length, 1, "new steering takes precedence over the saved answer");
      assert.match(prompts[0], /accepted while reopening/);
      assert.equal(w.lastText, "updated answer");
    } finally { w.dispose(); await w.job.close(); }
  }
});

scenario("recovery-read-close-failure", async () => {
  const w = worker("read-close-failure", true);
  const seed = await DurableJob.open(w.options, "work");
  await seed.close(false);
  w.recoveryKey = seed.key;
  const open = DurableJob.open;
  let job, close, attempts = 0;
  DurableJob.open = async (...args) => {
    job = await open.call(DurableJob, ...args);
    close = job.harness.close.bind(job.harness);
    job.harness.close = async () => { attempts++; throw new Error("read Harness close failed"); };
    return job;
  };
  try {
    await assert.rejects(PiWorker.recover(w.options, "work", seed.key, w), /read Harness close failed/);
    assert.equal(w.job, job, "failed pre-read shutdown stays attached for cleanup");
    await assert.rejects(w.releaseRecovery(), /read Harness close failed/);
    assert.equal(attempts, 1, "the rejected shutdown cannot become a successful second close");
    assert.equal(owns(seed.key), true, "the still-open Harness retains ownership");
    assert.equal(w.recoveryCleanupFailed, true);
  } finally {
    DurableJob.open = open;
    await close?.(BACKGROUND_CONTEXT);
    forgetOwnedJob(seed.key);
  }
});

try {
  for (const { name, execute } of scenarios) if (!selected || selected === name) {
    await execute(); console.log(`  OK -> worker run: ${name}`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
