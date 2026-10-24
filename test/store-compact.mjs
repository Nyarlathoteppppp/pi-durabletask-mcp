import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Each checkpoint rewrites the whole transcript, so a finished store is often half free pages.
const dir = await mkdtemp(join(tmpdir(), "pi-store-compact-"));
const state = join(dir, "state");
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: state,
  PI_DELEGATE_STORAGE_LIMIT_MB: "2" });
await mkdir(join(dir, "agent"));
const { PiWorker } = await import("../dist/pi/worker.js");
const { DurableJob, sweep } = await import("../dist/durable.js");
const store = (key) => join(state, "durable", "v2", "jobs", key, "session.sqlite");
const size = (key) => statSync(store(key)).size;
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const worker = new PiWorker({ id: "base", cwd: dir, tools: [], maxTurns: 20, maxDurationMs: 10000 });
worker.session = { sessionManager: SessionManager.inMemory(dir), messages: [], dispose: () => {} };
const base = JSON.parse(JSON.stringify(worker.checkpoint()));
worker.dispose();
const withText = (kb) => ({ ...base, entries: [{ type: "custom", customType: "filler", data: "x".repeat(kb * 1024) }] });

/** A job whose checkpoints grew to 800 KiB and then ended with a small one. */
const grown = async (id, finished) => {
  const job = await DurableJob.open({ id, cwd: dir, tools: [], maxTurns: 20, maxDurationMs: 10000, durable: true }, "work");
  const { done } = await job.begin("work", base, async () => {
    for (const kb of [200, 400, 600, 800]) await job.save(withText(kb));
    return withText(10);
  });
  await done;
  if (finished) job.recordFinal({ ...base.snapshot, state: "done", finishedAt: new Date().toISOString() });
  return job;
};

try {
  // A finished job is compacted when it is closed, before its lock is released.
  // (The store is in WAL mode: its size means something only once closed.) Uncompacted, these ~1.5 MiB.
  const done = await grown("finished", true);
  await done.close();
  assert.ok(size(done.key) < 256 * 1024, `finished store is ${size(done.key)} bytes`);

  // An unfinished job is closed as it is: it will be opened again, and shutdown should stay quick.
  const open = await grown("unfinished", false);
  await open.close();
  assert.ok(size(open.key) > 1024 * 1024, `unfinished store is ${size(open.key)} bytes`);

  // Over the size limit, the sweep reclaims free pages of finished stores before deleting any history.
  const db = new DatabaseSync(store(done.key));
  db.exec("CREATE TABLE filler (data BLOB)");
  db.prepare("INSERT INTO filler VALUES (?)").run(Buffer.alloc(3 * 1024 * 1024));
  db.exec("DROP TABLE filler");
  db.close();
  assert.ok(size(done.key) > 3 * 1024 * 1024);
  const removed = sweep();
  assert.deepEqual(removed, [], "compaction brought storage under the limit, so nothing was deleted");
  assert.ok(existsSync(store(done.key)));
  assert.ok(size(done.key) < 1024 * 1024, `swept store is ${size(done.key)} bytes`);
  console.log("  OK -> finished durable stores are compacted on close, and under size pressure before any history is deleted");
} finally {
  await rm(dir, { recursive: true, force: true });
}
