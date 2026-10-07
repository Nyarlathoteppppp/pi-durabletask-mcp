import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = fs.mkdtempSync(join(tmpdir(), "pi-forget-cleanup-"));
process.env.PI_OFFLINE = "1";
process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
process.env.PI_DELEGATE_STATE_DIR = join(directory, "state");
const { sweep, forgetOwnedJob, DURABLE_DIR } = await import("../dist/durable.js");
const { owns, tryAcquire, release } = await import("../dist/ownership.js");
const key = randomUUID();
const path = join(DURABLE_DIR, "jobs", key);
const rm = fs.rmSync;
let catalog;
try {
  sweep();
  catalog = new DatabaseSync(join(DURABLE_DIR, "catalog.sqlite"));
  catalog.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at) VALUES (?, 0, ?, ?, 'fixture', ?)")
    .run(key, process.env.PI_CODING_AGENT_DIR, JSON.stringify({ id: key }), Date.now());
  fs.mkdirSync(path);
  fs.writeFileSync(join(path, "session.sqlite"), "fixture");
  assert.ok(tryAcquire(key));

  // Exercise a real deletion error path without depending on platform permissions/root.
  fs.rmSync = (target, options) => {
    if (target === path) throw Object.assign(new Error("fixture removal denied"), { code: "EACCES" });
    return rm(target, options);
  };
  syncBuiltinESMExports();
  assert.throws(() => forgetOwnedJob(key), { code: "EACCES" });
  assert.equal(catalog.prepare("SELECT 1 FROM jobs WHERE key = ?").get(key), undefined);
  assert.ok(fs.existsSync(path), "failed removal leaves an orphan for cleanup");
  assert.equal(owns(key), false, "deletion failure must release ownership for a later sweep");

  fs.rmSync = rm;
  syncBuiltinESMExports();
  assert.deepEqual(sweep(), [key]);
  assert.equal(fs.existsSync(path), false);
  console.log("  OK -> failed forget releases ownership and a later sweep reclaims the orphan");
} finally {
  fs.rmSync = rm;
  syncBuiltinESMExports();
  release(key);
  catalog?.close();
  rm(directory, { recursive: true, force: true });
}
