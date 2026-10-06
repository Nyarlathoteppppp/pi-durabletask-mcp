import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// A recovery that fails for a passing reason (say an auth refresh) hands the job back, so the next
// recovery tick, in this or another process, retries it; the failed attempt still counts. Only a job
// past its attempts is kept and reported, so it is not retried forever.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-recovery-failure-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: join(dir, "state") });
await mkdir(join(dir, "agent"), { recursive: true });
const durable = await import("../dist/durable.js");
const registry = await import("../dist/registry.js");
const { PiWorker } = await import("../dist/pi/worker.js");
let failWith;
PiWorker.recover = async (_options, _prompt, _key, worker) => {
  if (failWith === "stopped") throw new durable.RecoveryStopped("Recovery stopped: claimed 4 times");
  if (failWith) throw new Error(failWith);
  worker.state = "running";
  return worker;
};
const KEY = "00000000-0000-4000-8000-0000000fa11e";
const catalog = () => new DatabaseSync(join(dir, "state", "durable", "v2", "catalog.sqlite"));
const row = () => catalog().prepare("SELECT pid, attempts FROM jobs WHERE key = ?").get(KEY);
try {
  durable.claimAbandoned(new Set(), 0); // creates the catalog
  const db = catalog();
  db.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt) VALUES (?, 0, ?, ?, 'x')")
    .run(KEY, join(dir, "agent"), JSON.stringify({ id: "flaky", cwd: dir, tools: [], maxTurns: 5, maxDurationMs: 60000 }));
  db.close();

  failWith = "auth refresh failed";
  await registry.recoverAbandoned();
  assert.equal(registry.loaded("flaky"), undefined, "a failed recovery does not keep a dead worker here");
  assert.deepEqual({ pid: row().pid, attempts: row().attempts }, { pid: 0, attempts: 1 }, "handed back, attempt counted");
  assert.equal(durable.claimAbandoned(new Set(), 0).records.length, 0);
  const other = durable.claimAbandoned(new Set(), 1); // as another process's tick would
  assert.equal(other.records.length, 1, "free for the next claim");
  durable.unclaim(other.records[0].key);

  failWith = undefined;
  await registry.recoverAbandoned();
  assert.equal(registry.loaded("flaky")?.state, "running", "the next tick recovers it");
  // A job past its attempts is kept here and reported, so nothing retries it.
  const db2 = catalog();
  db2.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt) VALUES (?, 0, ?, ?, 'x')")
    .run("00000000-0000-4000-8000-00000000057e", join(dir, "agent"), JSON.stringify({ id: "spent", cwd: dir, tools: [], maxTurns: 5, maxDurationMs: 60000 }));
  db2.close();
  failWith = "stopped";
  await registry.recoverAbandoned();
  assert.match(registry.loaded("spent")?.error ?? "", /Recovery stopped/);
  assert.equal(durable.claimAbandoned(new Set(), 1).records.length, 0, "still held, not retried");
  console.log("  OK -> a recovery that fails is handed back and retried; the attempt still counts; a spent one is kept and reported");
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
