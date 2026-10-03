import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = mkdtempSync(join(tmpdir(), "pi-orphan-gc-"));
process.env.PI_OFFLINE = "1";
process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
process.env.PI_DELEGATE_STATE_DIR = join(directory, "state");
process.env.PI_DELEGATE_STORAGE_LIMIT_MB = "1";
const { sweep, DURABLE_DIR } = await import("../dist/durable.js");
const { tryAcquire, release } = await import("../dist/ownership.js");
const exec = DatabaseSync.prototype.exec;
const store = (key, size = 32) => {
  const path = join(DURABLE_DIR, "jobs", key);
  mkdirSync(path);
  const file = join(path, "session.sqlite");
  writeFileSync(file, "fixture");
  truncateSync(file, size); // Sparse fixture; no large checkpoint or model call.
  return path;
};
let catalog, child;
try {
  sweep();
  catalog = new DatabaseSync(join(DURABLE_DIR, "catalog.sqlite"));
  const now = Date.now();
  const finished = (key) => catalog.prepare(
    "INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at) VALUES (?, 0, ?, ?, 'fixture', ?)",
  ).run(key, process.env.PI_CODING_AGENT_DIR, JSON.stringify({ id: key }), now);

  const history = randomUUID(), orphan = randomUUID();
  finished(history);
  const retained = store(history), garbage = store(orphan, 1024 * 1024);
  assert.deepEqual(sweep(now), [orphan], "orphan bytes are reclaimed before applying size pressure");
  assert.equal(existsSync(garbage), false);
  assert.ok(existsSync(retained), "healthy history remains below the limit after cleanup");
  assert.ok(catalog.prepare("SELECT 1 FROM jobs WHERE key = ?").get(history));
  assert.equal(existsSync(join(DURABLE_DIR, "ownership", `${orphan}.sqlite`)), false);

  const local = randomUUID();
  assert.ok(tryAcquire(local));
  const localStore = store(local);
  assert.deepEqual(sweep(now), []);
  assert.ok(existsSync(localStore), "a local creator holding the lock is protected before catalog insertion");
  release(local);
  assert.deepEqual(sweep(now), [local]);

  const remote = randomUUID(), remoteStore = store(remote);
  const ownershipUrl = new URL("../dist/ownership.js", import.meta.url).href;
  child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { initOwnership, tryAcquire, release } = await import(${JSON.stringify(ownershipUrl)});
    initOwnership(${JSON.stringify(join(DURABLE_DIR, "ownership"))});
    if (!tryAcquire(${JSON.stringify(remote)})) throw new Error('fixture lock unavailable');
    process.on('message', () => { release(${JSON.stringify(remote)}); process.exit(0); });
    process.send('locked');
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock fixture exited before readiness: ${code}`)));
  });
  assert.deepEqual(sweep(now), []);
  assert.ok(existsSync(remoteStore), "another process's unregistered live store is protected");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.send("release");
  await exited;
  assert.deepEqual(sweep(now), [remote]);

  const raced = randomUUID(), racedStore = store(raced);
  let inserted = false;
  DatabaseSync.prototype.exec = function (sql) {
    if (!inserted && sql === "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE") {
      inserted = true;
      finished(raced); // Registration between the initial lookup and lock acquisition.
    }
    return exec.call(this, sql);
  };
  assert.deepEqual(sweep(now), []);
  assert.ok(inserted);
  assert.ok(existsSync(racedStore), "catalog membership is checked again under the lock");
  console.log("  OK -> orphan cleanup precedes pressure, preserves local/remote owners and rechecks catalog membership");
} finally {
  DatabaseSync.prototype.exec = exec;
  if (child?.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
  catalog?.close();
  rmSync(directory, { recursive: true, force: true });
}
