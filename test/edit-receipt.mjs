import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "pi-edit-receipt-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: join(dir, "state") });
await mkdir(join(dir, "agent"));
const { PiWorker } = await import("../dist/pi/worker.js");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { MemoryJob, DurableJob } = await import("../dist/durable.js");
const { waitResult } = await import("../dist/tools/shared.js");
const make = (id) => {
  const w = new PiWorker({ id, cwd: dir, tools: [], maxTurns: 20, maxDurationMs: 10000 });
  w.session = { sessionManager: SessionManager.inMemory(dir), messages: [],
    prompt: async () => {}, waitForIdle: async () => {}, abort: async () => {}, dispose: () => {} };
  return w;
};
const start = (w, id, name, args, parentToolCallId) => w.onEvent({ type: "tool_execution_start", toolCallId: id, toolName: name, args,
  ...(parentToolCallId ? { parentToolCallId } : {}) });
const end = (w, id, name, isError = false) => w.onEvent({ type: "tool_execution_end", toolCallId: id, toolName: name, isError, result: { content: [] } });
const receipt = (w) => { const s = w.snapshot(); return [s.touchedFiles, s.editWriteCount]; };
const w = make("receipt");
try {
  assert.deepEqual(receipt(w), [undefined, undefined], "read-only results carry no receipt");
  // path comes after large content in the raw arguments; the compact JSON cannot supply it.
  start(w, "write", "write", { content: "x".repeat(4000), path: "a.txt" });
  assert.deepEqual(receipt(w), [undefined, undefined], "pending calls are not successes");
  end(w, "write", "write");
  assert.deepEqual(receipt(w), [["a.txt"], 1]);
  end(w, "write", "write");
  start(w, "edit", "edit", { path: "a.txt", oldText: "a", newText: "b" }); end(w, "edit", "edit");
  start(w, "failed", "edit", { path: "failed.txt" }); end(w, "failed", "edit", true);
  start(w, "read", "read", { path: "read.txt" }); end(w, "read", "read");
  start(w, "parent", "codemode", {});
  start(w, "nested", "write", { path: "/tmp/b.txt" }, "parent"); end(w, "nested", "write"); end(w, "parent", "codemode", true);
  assert.deepEqual(receipt(w), [["a.txt", "/tmp/b.txt"], 3], "successful nested writes survive a failed parent; duplicates and failed edits do not count");
  assert.deepEqual(waitResult(w.snapshot()).touchedFiles, ["a.txt", "/tmp/b.txt"]);
  assert.equal(waitResult(w.snapshot()).editWriteCount, 3);

  const saved = JSON.parse(JSON.stringify(w.checkpoint()));
  const job = await DurableJob.open({ ...w.options, id: "stored-receipt", durable: true }, "work");
  try {
    const { done } = await job.begin("work", saved, async (_prompt, checkpoint) => checkpoint);
    await done;
    const loaded = JSON.parse(JSON.stringify(await job.saved()));
    const restored = make("restored");
    try {
      restored.restoreSnapshot(loaded);
      assert.deepEqual(receipt(restored), receipt(w), "current-run receipt survives real durable storage");
      restored.job = new MemoryJob();
      await restored.beginDurable("recovery", loaded, true);
      await restored.run;
      assert.deepEqual(receipt(restored), receipt(w), "resuming this run keeps its receipt");
      // Old checkpoints have a cumulative trace but no per-run receipt. Never reconstruct from it.
      delete loaded.snapshot.touchedFiles; delete loaded.snapshot.editWriteCount;
      restored.restoreSnapshot(loaded);
      assert.deepEqual(receipt(restored), [undefined, undefined]);
    } finally { restored.dispose(); }
  } finally { await job.forget(); }

  w.state = "done";
  w.job = new MemoryJob();
  await w.followUp("read-only follow-up"); await w.run;
  assert.deepEqual(receipt(w), [undefined, undefined], "follow-up does not inherit prior writes");
  console.log("  OK -> per-run successful edit/write receipt, raw paths, nested calls, durable restoration and follow-up reset");
} finally { w.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
