import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "pi-start-cancel-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"),
  PI_DELEGATE_STATE_DIR: join(dir, "state") });
await mkdir(join(dir, "agent"));
await writeFile(join(dir, "agent", "models.json"), JSON.stringify({ providers: { test: {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fake-key",
  models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000,
    maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { PiWorker } = await import("../dist/pi/worker.js");
const { DurableJob, MemoryJob, storedSnapshot } = await import("../dist/durable.js");
const { getRuntime } = await import("../dist/pi/runtime.js");
const rt = await getRuntime();
const getAuth = rt.getAuth;
try {
  for (const durable of [false, true]) {
    for (const action of ["abort", "abort-auth-error", "suspend", "abort-create"]) {
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      rt.getAuth = async () => {
        if (action === "abort-create") return "fake-key";
        entered.resolve();
        await release.promise;
        if (action === "abort-auth-error") throw new Error("refresh failed after cancellation");
        return "fake-key";
      };
      const options = { id: `${action}-${durable}`, cwd: dir, model: "test/one", tools: [],
        durable, maxTurns: 5, maxDurationMs: 60000 };
      const worker = new PiWorker(options);
      let prompts = 0;
      worker.model = options.model;
      worker.session = { sessionManager: SessionManager.inMemory(dir), messages: [],
        prompt: async () => { prompts++; }, waitForIdle: async () => {},
        abort: async () => {}, dispose: () => {} };
      worker.job = durable ? await DurableJob.open(worker.options, "work") : new MemoryJob();
      const job = worker.job;
      if (action === "abort-create") {
        const begin = job.begin.bind(job);
        job.begin = async (...args) => {
          entered.resolve();
          await release.promise;
          return begin(...args);
        };
      }
      try {
        const starting = worker.beginDurable("work");
        await entered.promise;
        if (action === "suspend") await worker.suspend();
        else await worker.abort("caller_cancelled");
        if (action === "abort-create") assert.equal(worker.isActive, true, "pending task creation retains capacity after cancellation");
        release.resolve();
        await starting;
        await worker.run;
        assert.equal(prompts, 0, `${action}: completing startup must not start cancelled work`);
        if (action !== "suspend") {
          assert.equal(worker.isActive, false, "finalized cancellation releases capacity");
          assert.equal(worker.state, "aborted");
          assert.equal(worker.termination.reason, "caller_cancelled");
          if (durable) {
            assert.equal(storedSnapshot(worker.id).state, "aborted", "the catalog retains cancellation");
            assert.equal((await job.saved()).snapshot.state, "aborted", "the durable task retains cancellation");
          }
        }
      } finally {
        worker.dispose();
        await job.forget();
      }
    }
  }
  // abort during authentication, then follow_up at once: the cancelled run must not resume when its
  // authentication completes, even though the worker is already starting the new one.
  for (const durable of [false, true]) {
    const release = Promise.withResolvers();
    let waiting = 0;
    const entered = [Promise.withResolvers(), Promise.withResolvers()];
    rt.getAuth = async () => { entered[waiting++]?.resolve(); await release.promise; return "fake-key"; };
    const options = { id: `abort-then-follow-${durable}`, cwd: dir, model: "test/one", tools: [],
      durable, maxTurns: 5, maxDurationMs: 60000 };
    const worker = new PiWorker(options);
    const prompts = [];
    worker.model = options.model;
    worker.session = { sessionManager: SessionManager.inMemory(dir), messages: [],
      prompt: async (text) => { prompts.push(text); }, waitForIdle: async () => {},
      abort: async () => {}, dispose: () => {} };
    worker.job = durable ? await DurableJob.open(worker.options, "work") : new MemoryJob();
    const job = worker.job;
    worker.state = "done";
    try {
      const first = worker.followUp("cancelled");
      await entered[0].promise;
      await worker.abort("caller_cancelled");
      const second = worker.followUp("replacement");
      await entered[1].promise;
      release.resolve();
      await Promise.all([first, second]);
      await worker.run;
      assert.deepEqual(prompts.filter((p) => p.includes("cancelled") || p.includes("replacement")).length, 1,
        `durable=${durable}: one run reaches Pi, not both`);
      assert.ok(prompts.some((p) => p.includes("replacement")), `durable=${durable}: the new follow_up runs`);
    } finally {
      worker.dispose();
      await job.forget();
    }
  }
  // A follow_up cancelled before it reaches Pi wrote nothing: it must not report the previous run's
  // saved file or answer flag.
  for (const durable of [false, true]) {
    const release = Promise.withResolvers(), entered = Promise.withResolvers();
    rt.getAuth = async () => { entered.resolve(); await release.promise; return "fake-key"; };
    const options = { id: `stale-save-${durable}`, cwd: dir, model: "test/one", tools: [], durable, maxTurns: 5, maxDurationMs: 60000 };
    const worker = new PiWorker(options);
    worker.model = options.model;
    worker.session = { sessionManager: SessionManager.inMemory(dir), messages: [],
      prompt: async () => {}, waitForIdle: async () => {}, abort: async () => {}, dispose: () => {} };
    worker.job = durable ? await DurableJob.open(worker.options, "work") : new MemoryJob();
    const job = worker.job;
    Object.assign(worker, { state: "done", lastText: "old answer", saved: { savedTo: "/tmp/old.md", savedChars: 10 }, answerFlag: "partial" });
    try {
      const followUp = worker.followUp("next");
      await entered.promise;
      await worker.abort("caller_cancelled");
      release.resolve();
      await followUp;
      await worker.run;
      const snap = worker.snapshot();
      assert.deepEqual([snap.state, snap.savedTo, snap.answerState], ["aborted", undefined, undefined], `durable=${durable}`);
    } finally {
      worker.dispose();
      await job.forget();
    }
  }
  console.log("  OK -> abort/suspend during authentication or task creation never prompt; durable cancellation persists");
} finally {
  rt.getAuth = getAuth;
  await rm(dir, { recursive: true, force: true });
}
