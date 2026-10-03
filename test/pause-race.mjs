import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { claimAbandoned, DurableJob } from "../dist/durable.js";
import { PiWorker } from "../dist/pi/worker.js";

const options = { cwd: "/tmp", id: "pause-race", tools: [], maxTurns: 5, maxDurationMs: 60000 };
const worker = new PiWorker(options);
let finishPrompt;
let enteredPrompt;
const entered = new Promise((resolve) => { enteredPrompt = resolve; });
const prompt = new Promise((resolve) => { finishPrompt = resolve; });
worker.session = {
  sessionManager: SessionManager.inMemory("/tmp"),
  prompt: () => { enteredPrompt(); return prompt; },
  waitForIdle: async () => {}, abort: async () => { finishPrompt(); }, dispose: () => {},
};
worker.job = await DurableJob.open({ ...options, startedAt: worker.startedAt }, "stub");
await worker.beginDurable("stub");
await entered;
const originalSave = worker.job.save.bind(worker.job);
worker.job.save = async (checkpoint) => {
  const saved = originalSave(checkpoint);
  // Finish precisely after suspend's flag was set, before Harness.close cancels its task.
  finishPrompt();
  await new Promise((resolve) => setImmediate(resolve));
  await saved;
};
await worker.suspend();
await worker.run;
assert.equal(claimAbandoned(new Set(), 1)[0].key, worker.job.key);
const reopened = await DurableJob.open(options, "stub", worker.job.key);
try {
  assert.equal(reopened.needsResume, true, "pause must not fault or complete the task");
  const saved = await reopened.saved();
  assert.equal(saved.snapshot.state, "running");
  const { done } = await reopened.begin("stub", saved, async (_input, checkpoint) => ({
    ...checkpoint, snapshot: { ...checkpoint.snapshot, state: "done", lastText: "resumed" },
  }), true);
  assert.equal((await done).snapshot.lastText, "resumed");
  console.log("  OK -> SDK completion during shutdown stays pending and resumes");
} finally { await reopened.forget(); }
