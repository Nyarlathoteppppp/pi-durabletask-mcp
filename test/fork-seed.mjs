import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const dir = await mkdtemp(join(tmpdir(), "pi-delegate-fork-seed-"));
Object.assign(process.env, { PI_CODING_AGENT_DIR: join(dir, "agent"),
  PI_DELEGATE_STATE_DIR: join(dir, "state"), PI_OFFLINE: "1" });
const { DurableJob } = await import("../dist/durable.js");
const options = { id: "fork-seed", cwd: dir, tools: [], durable: true, maxTurns: 10, maxDurationMs: 60000 };
const initial = { phase: "execute", entries: [{ type: "session", version: 3, id: "child-sdk-id",
  cwd: dir, timestamp: new Date().toISOString() }, { type: "message", id: "history-entry", parentId: null,
  timestamp: new Date().toISOString(), message: { role: "user", content: "INHERITED_HISTORY", timestamp: Date.now() } }],
  snapshot: { sessionId: options.id, cwd: dir, state: "starting", turns: 0 },
  inputStarted: false, results: {}, steering: [] };
const seedDoc = defineDoc({ kind: "pi-delegate.fork-seed", version: 1, scope: "session", initial: () => ({ checkpoint: null }) });
let job;
try {
  job = await DurableJob.open(options, "fork prompt", undefined, initial);
  const key = job.key;
  await job.close(false);
  job = await DurableJob.open(options, "fork prompt", key);
  assert.equal(job.needsResume, true);
  assert.deepEqual(await job.saved(), initial, "bootstrap recovers history before a task exists");
  const completed = { ...initial, inputStarted: true, snapshot: { ...initial.snapshot, state: "done", turns: 1 } };
  const { done } = await job.begin("fork prompt", initial, async (_prompt, saved) => {
    assert.deepEqual(saved, initial);
    return completed;
  }, true);
  await done;
  const seed = await job.harness.commit(async (tx) => (await tx.doc(seedDoc)).checkpoint, BACKGROUND_CONTEXT);
  assert.equal(seed, null, "first task creation consumes the seed in the same transaction");
  await job.close(false);
  job = await DurableJob.open(options, "fork prompt", key);
  assert.equal(job.needsResume, false);
  assert.deepEqual(await job.saved(), completed, "terminal task wins on reopen, not the initial seed");
  console.log("  OK -> durable fork bootstrap survives reopening before begin; first task consumes seed atomically; completed history stays current");
} finally {
  await job?.forget();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
