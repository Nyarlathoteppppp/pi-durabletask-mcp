import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = await mkdtemp(join(tmpdir(), "pi-unload-failure-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"),
  PI_DELEGATE_STATE_DIR: join(dir, "state"), PI_DELEGATE_HISTORY: "1" });
await mkdir(join(dir, "agent"));
const durable = await import("../dist/durable.js");
const registry = await import("../dist/registry.js");
const { PiWorker } = await import("../dist/pi/worker.js");
const { owns } = await import("../dist/ownership.js");
const recover = PiWorker.recover;
let failClose = true, nativeCloses = 0;
PiWorker.recover = async (options, _prompt, key, worker) => {
  worker.state = options.id === "busy" ? "running" : "done";
  worker.session = { dispose() {}, prompt() { throw new Error("disposed session must not execute"); } };
  if (options.id === "failure") worker.job = {
    async close() { if (failClose) throw new Error("Harness close failed"); durable.releaseJob(key); },
    async forget() { if (failClose) throw new Error("Harness close failed"); durable.forgetOwnedJob(key); },
  };
  if (options.id === "native") {
    worker.nativeClose = Promise.reject(new Error("native close failed"));
    worker.nativeClose.catch(() => {});
    worker.job = { async close() { nativeCloses++; durable.releaseJob(key); },
      async forget() { durable.forgetOwnedJob(key); } };
  }
  return worker;
};
let db;
try {
  durable.claimAbandoned(new Set(), 0);
  db = new DatabaseSync(join(durable.DURABLE_DIR, "catalog.sqlite"));
  const add = (id, key, finished) => db.prepare(
    "INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at) VALUES (?, 0, ?, ?, 'fixture', ?)",
  ).run(key, join(dir, "agent"), JSON.stringify({ id, cwd: dir, tools: [], maxTurns: 5, maxDurationMs: 10000 }), finished ? Date.now() : null);
  add("busy", "00000000-0000-4000-8000-000000000001", false);
  const key = "00000000-0000-4000-8000-000000000002";
  add("failure", key, true);
  await registry.recoverAbandoned();
  const worker = await registry.resolve("failure");
  registry.evictHistory();
  assert.equal(await registry.resolve("failure"), worker, "failed unload retains a queryable diagnostic worker");
  assert.equal(worker.state, "error");
  assert.match(worker.error, /Harness close failed/);
  assert.equal(worker.recoveryCleanupFailed, true);
  assert.equal(worker.snapshot().canFollowUp, false);
  assert.equal(worker.snapshot().followUpBlockedReason, "cleanup_failed");
  assert.ok(owns(key), "do not release ownership before the executor closes");
  assert.throws(() => worker.followUp("continue"), /cleanup/i);
  registry.evictHistory();
  assert.equal(registry.loaded("failure"), worker, "failed cleanup is not evicted repeatedly");
  await assert.rejects(registry.forget("failure"), /Harness close failed/);
  assert.equal(registry.loaded("failure"), worker, "failed forget also retains ownership diagnostics");
  // This fixture can close once its error is removed; real SDK close retry is not asserted.
  failClose = false;
  await registry.forget("failure");
  assert.equal(owns(key), false);
  assert.equal(durable.storedIdInUse("failure"), false);

  const nativeKey = "00000000-0000-4000-8000-000000000003";
  add("native", nativeKey, true);
  const native = await registry.resolve("native");
  registry.evictHistory();
  const reloaded = await registry.resolve("native");
  assert.notEqual(reloaded, native, "native shutdown rejection does not prevent unloading");
  assert.equal(nativeCloses, 1, "native rejection still closes the executor and releases the lock");
  assert.match(native.notices.at(-1).message, /native close failed/);
  await registry.forget("native");
  assert.equal(owns(nativeKey), false);
  console.log("  OK -> failed unload/forget retain diagnostics; native failure still closes the durable executor");
} finally {
  PiWorker.recover = recover;
  db?.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
