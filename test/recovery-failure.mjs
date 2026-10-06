import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// A recovery that fails for a passing reason (say an auth refresh) hands the job back only after
// its real executor is closed; the next recovery tick retries it and the failed attempt remains.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-recovery-failure-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: join(dir, "state"), PI_DELEGATE_HISTORY: "1" });
await mkdir(join(dir, "agent"), { recursive: true });
const durable = await import("../dist/durable.js");
const registry = await import("../dist/registry.js");
const { PiWorker } = await import("../dist/pi/worker.js");
const { owns } = await import("../dist/ownership.js");
const recover = PiWorker.recover;
let failWith;
let attachJob = false;
let patchClose;
let openedJob;
const pendingCheckpoint = {
  phase: "execute", entries: [], snapshot: { state: "running" }, inputStarted: false, results: {}, steering: [],
};
PiWorker.recover = async (options, _prompt, key, worker) => {
  if (failWith === "stopped") throw new durable.RecoveryStopped("Recovery stopped: claimed 4 times");
  if (failWith) {
    if (attachJob) {
      const job = await durable.DurableJob.open(options, "x", key);
      worker.job = job;
      openedJob = job;
      if (patchClose) patchClose(job, worker);
      if (!job.needsResume) {
        const { done } = await job.begin("x", pendingCheckpoint, async () => new Promise(() => {}));
        void done.catch(() => {});
      }
    }
    throw new Error(failWith);
  }
  worker.state = "running";
  return worker;
};
const KEY = "00000000-0000-4000-8000-0000000fa11e";
const catalog = () => new DatabaseSync(join(dir, "state", "durable", "v2", "catalog.sqlite"));
const row = (key = KEY) => {
  const db = catalog();
  try { return db.prepare("SELECT pid, attempts FROM jobs WHERE key = ?").get(key); }
  finally { db.close(); }
};
const options = (id) => ({ id, cwd: dir, tools: [], maxTurns: 5, maxDurationMs: 60000 });
const insert = (key, id, finished = false) => {
  const db = catalog();
  db.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at, snapshot) VALUES (?, 0, ?, ?, 'x', ?, ?)")
    .run(key, join(dir, "agent"), JSON.stringify(options(id)), finished ? Date.now() : null,
      finished ? JSON.stringify({ state: "done", turns: 0 }) : null);
  db.close();
};
const preparedIds = new Set();
const prepareUnfinished = async (key, id) => {
  insert(key, id);
  const claimed = durable.claimAbandoned(preparedIds, 1).records;
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].key, key);
  preparedIds.add(id);
  const job = await durable.DurableJob.open(options(id), "x", key);
  const { done } = await job.begin("x", pendingCheckpoint, async () => new Promise(() => {}));
  void done.catch(() => {});
  await job.close(false);
  durable.releaseJob(key);
};
const forgetReleased = (key, id) => {
  const claimed = durable.claimAbandoned(new Set([...preparedIds].filter((other) => other !== id)), 1).records;
  assert.equal(claimed[0]?.key, key);
  durable.forgetOwnedJob(key);
};
try {
  durable.claimAbandoned(new Set(), 0); // creates the catalog
  await prepareUnfinished(KEY, "flaky");

  // A failed recovery opens and mounts a real unfinished DurableJob before failing. close(false)
  // must complete, release ownership, preserve attempts, and leave the executor marked closing.
  failWith = "auth refresh failed";
  attachJob = true;
  await registry.recoverAbandoned();
  assert.equal(registry.loaded("flaky"), undefined, "a cleaned-up failed recovery is not kept");
  assert.equal(openedJob.closing, true, "production cleanup closes the real durable job");
  assert.deepEqual({ pid: row().pid, attempts: row().attempts }, { pid: 0, attempts: 1 },
    "close(false) releases ownership without clearing the counted attempt");
  assert.equal(durable.claimAbandoned(new Set(), 0).records.length, 0);
  const other = durable.claimAbandoned(new Set(), 1);
  assert.equal(other.records.length, 1, "free for the next claim");
  durable.unclaim(other.records[0].key);

  // The job-without-mounted-executor path remains covered: releaseRecovery may still release it.
  const plainKey = "00000000-0000-4000-8000-000000000111";
  await prepareUnfinished(plainKey, "plain");
  attachJob = false;
  await registry.recoverAbandoned();
  assert.equal(registry.loaded("plain"), undefined);
  assert.equal(row(plainKey).pid, 0);

  failWith = undefined;
  await registry.recoverAbandoned();
  assert.equal(registry.loaded("flaky")?.state, "running", "the next tick recovers it");
  assert.equal(registry.loaded("flaky")?.recoveryCleanupFailed, false, "successful recovery clears cleanup failure");
  // End these mocked live recoveries before testing the one-entry history budget below.
  for (const id of ["flaky", "plain"]) {
    registry.loaded(id).state = "done";
    await registry.forget(id);
  }

  // resolve() also cleans a claimed, finished catalog row through the same path.
  const historyKey = "00000000-0000-4000-8000-000000000222";
  insert(historyKey, "history", true);
  failWith = "resolve auth failed";
  attachJob = true;
  await assert.rejects(() => registry.resolve("history"), /resolve auth failed/);
  assert.equal(openedJob.closing, true, "resolve closes its real durable job on failure");
  assert.equal(registry.loaded("history"), undefined);
  assert.equal(owns(historyKey), false, "resolve cleanup releases the history ownership");
  // The failure fixture began a task, so the row is now unfinished and reclaimed via recovery.
  const historyClaim = durable.claimAbandoned(preparedIds, 1).records;
  assert.equal(historyClaim[0]?.key, historyKey, "released executor can be claimed again");
  durable.forgetOwnedJob(historyKey);

  // A close(false) rejection keeps the lock and worker for diagnosis, without rejecting the
  // background recovery round with the cleanup error.
  const cleanupKey = "00000000-0000-4000-8000-000000000333";
  await prepareUnfinished(cleanupKey, "cleanup");
  let restoreCleanupClose;
  patchClose = (job) => {
    const close = job.close.bind(job);
    restoreCleanupClose = () => { job.close = close; };
    job.close = async (release = true) => {
      if (!release) throw new Error("harness close failed");
      return close(release);
    };
  };
  failWith = "cleanup auth failed";
  attachJob = true;
  await registry.recoverAbandoned();
  const cleanupWorker = registry.loaded("cleanup");
  assert.equal(cleanupWorker?.state, "error", "cleanup failure keeps an error worker");
  assert.match(cleanupWorker?.error ?? "", /cleanup auth failed/);
  assert.match(cleanupWorker?.error ?? "", /harness close failed/);
  assert.equal(row(cleanupKey).attempts, 1, "cleanup failure keeps the counted attempt");
  assert.equal(durable.claimAbandoned(new Set(), 1).records.length, 0, "cleanup failure keeps ownership");
  cleanupWorker.finishedAt = "2000-01-01T00:00:00.000Z";
  registry.sweepStorage(true);
  registry.evictHistory();
  assert.equal(registry.loaded("cleanup"), cleanupWorker, "forced cleanup/eviction keeps the diagnostic worker");
  restoreCleanupClose();
  await cleanupWorker.releaseRecovery();
  assert.equal(cleanupWorker.recoveryCleanupFailed, false);
  forgetReleased(cleanupKey, "cleanup");
  await registry.forget("cleanup");

  // A native close rejection is only a notice: the real job close is still attempted and releases.
  const nativeKey = "00000000-0000-4000-8000-000000000444";
  await prepareUnfinished(nativeKey, "native");
  let nativeCloseCalls = 0, nativeWorker;
  patchClose = (job, worker) => {
    const close = job.close.bind(job);
    job.close = async (release = true) => { if (!release) nativeCloseCalls++; await close(release); };
    worker.nativeClose = Promise.reject(new Error("native close failed"));
    worker.nativeClose.catch(() => {});
    nativeWorker = worker;
  };
  failWith = "native auth failed";
  attachJob = true;
  await registry.recoverAbandoned();
  assert.equal(openedJob.closing, true, "native cleanup rejection still closes the job");
  assert.equal(nativeCloseCalls, 1);
  assert.match(nativeWorker.notices.at(-1).message, /native close failed/);
  assert.ok(registry.loaded("native") === undefined);
  assert.ok(registry.all().find((worker) => worker.id === "native") === undefined);
  assert.equal(row(nativeKey).pid, 0);
  forgetReleased(nativeKey, "native");

  // A job past its attempts is kept here and reported, so no cleanup path retries it.
  const spentKey = "00000000-0000-4000-8000-00000000057e";
  await prepareUnfinished(spentKey, "spent");
  patchClose = undefined;
  attachJob = false;
  failWith = "stopped";
  await registry.recoverAbandoned();
  assert.match(registry.loaded("spent")?.error ?? "", /Recovery stopped/);
  assert.equal(durable.claimAbandoned(new Set(), 1).records.length, 0, "still held, not retried");
  console.log("  OK -> recovery cleanup closes real jobs, preserves attempts, releases only on success, and keeps cleanup failures diagnostic");
} finally {
  PiWorker.recover = recover;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
