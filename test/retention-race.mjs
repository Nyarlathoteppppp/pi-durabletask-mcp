import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const directory = mkdtempSync(join(tmpdir(), "pi-retention-race-"));
process.env.PI_OFFLINE = "1";
process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
process.env.PI_DELEGATE_STATE_DIR = join(directory, "state");
process.env.PI_DELEGATE_RETENTION_DAYS = "7";
process.env.PI_DELEGATE_STORAGE_LIMIT_MB = "1024";
const { sweep, DURABLE_DIR } = await import("../dist/durable.js");
const exec = DatabaseSync.prototype.exec;
let catalog;
try {
  sweep();
  catalog = new DatabaseSync(join(DURABLE_DIR, "catalog.sqlite"));
  const key = randomUUID(), now = Date.now(), data = join(DURABLE_DIR, "jobs", key);
  catalog.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at) VALUES (?, 0, ?, ?, ?, ?)")
    .run(key, process.env.PI_CODING_AGENT_DIR, JSON.stringify({ id: "refreshed" }), "fixture", now - 8 * 86_400_000);
  mkdirSync(data);
  writeFileSync(join(data, "session.sqlite"), "synthetic fixture");
  let refreshed = false;
  // Simulate the previous owner finishing and releasing between the scan and lock acquisition.
  DatabaseSync.prototype.exec = function (sql) {
    if (!refreshed && sql === "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE") {
      refreshed = true;
      catalog.prepare("UPDATE jobs SET finished_at = ? WHERE key = ?").run(now, key);
    }
    return exec.call(this, sql);
  };
  assert.deepEqual(sweep(now), []);
  assert.ok(refreshed, "the timestamp changes after scanning but before taking the lock");
  assert.ok(existsSync(data), "the freshly completed job is retained");
  DatabaseSync.prototype.exec = exec;
  assert.deepEqual(sweep(now + 8 * 86_400_000), [key], "the skipped lock is released and later expiration still deletes it");
  assert.equal(existsSync(data), false);
  console.log("  OK -> sweep respects a completion refreshed before locking, releases its lock and later expires the job");
} finally {
  DatabaseSync.prototype.exec = exec;
  catalog?.close();
  rmSync(directory, { recursive: true, force: true });
}
