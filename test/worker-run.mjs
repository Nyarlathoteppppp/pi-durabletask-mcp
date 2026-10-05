import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "pi-worker-run-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(directory, "agent"),
  PI_DELEGATE_STATE_DIR: join(directory, "state") });
await mkdir(join(directory, "agent"));
const { PiWorker } = await import("../dist/pi/worker.js");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { MemoryJob, DurableJob } = await import("../dist/durable.js");
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
    w.job = durable ? await DurableJob.open(w.options, "previous") : new MemoryJob();
    w.job.begin = async () => { throw new Error("task creation failed"); };
    try {
      await assert.rejects(w.followUp("next"), /task creation failed/);
      assert.equal(w.state, "done");
      assert.equal(w.isActive, false, "failed task creation releases finalization activity");
      assert.equal(w.continuation.canFollowUp, true);
    } finally { w.dispose(); await w.job.forget(); }
  }
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

try {
  for (const { name, execute } of scenarios) if (!selected || selected === name) {
    await execute(); console.log(`  OK -> worker run: ${name}`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
