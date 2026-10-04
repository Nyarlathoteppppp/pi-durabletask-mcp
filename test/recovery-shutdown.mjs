import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// A recovery whose claim succeeds at once, with shutdown beginning before it registers the
// worker, must hand the claim back: no worker, the lock released, the attempt not counted.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-shutdown-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: join(dir, "state") });
await mkdir(join(dir, "agent"), { recursive: true });
const durable = await import("../dist/durable.js");
const registry = await import("../dist/registry.js");
const { PiWorker } = await import("../dist/pi/worker.js");
let started = 0;
PiWorker.recover = async (_options, _prompt, _key, worker) => { started++; worker.state = "running"; return worker; };
const KEY = "00000000-0000-4000-8000-00000000d0e1";
const catalog = () => new DatabaseSync(join(dir, "state", "durable", "v2", "catalog.sqlite"));
try {
  durable.claimAbandoned(new Set(), 0); // creates the catalog
  const db = catalog();
  db.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt) VALUES (?, 0, ?, ?, 'x')")
    .run(KEY, join(dir, "agent"), JSON.stringify({ id: "abandoned", cwd: dir, tools: [], maxTurns: 5, maxDurationMs: 60000 }));
  db.close();
  const recovering = registry.recoverAbandoned(); // claims synchronously, then awaits
  const stopping = registry.suspendAll();        // shutdown begins before registration
  await recovering;
  await stopping;
  assert.equal(registry.loaded("abandoned"), undefined, "no worker registered after shutdown began");
  assert.equal(started, 0, "nothing was resumed");
  const row = catalog().prepare("SELECT pid, attempts FROM jobs WHERE key = ?").get(KEY);
  assert.deepEqual({ pid: row.pid, attempts: row.attempts }, { pid: 0, attempts: 0 }, "the claim was handed back");
  assert.equal(durable.claimAbandoned(new Set(), 1).records.length, 1, "its lock is free for the next process");
  console.log("  OK -> a claim made just before shutdown is handed back, not registered");
} finally {
  await rm(dir, { recursive: true, force: true });
}
