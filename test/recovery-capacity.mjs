import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// A recovery that retries after a busy lock must re-read capacity and shutdown, not reuse the
// values from before its wait.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-capacity-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"),
  PI_DELEGATE_STATE_DIR: join(dir, "state"), PI_DELEGATE_MAX_CONCURRENT: "1" });
await mkdir(join(dir, "agent"), { recursive: true });
const durable = await import("../dist/durable.js");
const registry = await import("../dist/registry.js");
const { PiWorker } = await import("../dist/pi/worker.js");
const KEY = "00000000-0000-4000-8000-0000000c0de1";
const lockPath = join(dir, "state", "durable", "v2", "ownership", `${KEY}.sqlite`);

// Recovery and new work only need to occupy a slot here; no model runs.
PiWorker.recover = async (_options, _prompt, _key, worker) => { worker.state = "running"; return worker; };
PiWorker.prototype.start = async function () { this.state = "running"; return this; };

/** Another process holds the job's lock briefly, so the first claim sees it busy and waits. */
const holdBriefly = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(lockPath)});
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    process.stdout.write("ready");
    setTimeout(() => process.exit(0), 30);`], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.once("data", () => resolve(child));
  child.on("error", reject);
});
const abandon = () => {
  const catalog = new DatabaseSync(join(dir, "state", "durable", "v2", "catalog.sqlite"));
  catalog.prepare("DELETE FROM jobs WHERE key = ?").run(KEY);
  catalog.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt) VALUES (?, 0, ?, ?, 'x')")
    .run(KEY, join(dir, "agent"), JSON.stringify({ id: "abandoned", cwd: dir, tools: [], maxTurns: 5, maxDurationMs: 60000 }));
  catalog.close();
};
try {
  durable.claimAbandoned(new Set(), 0); // creates the catalog
  await mkdir(join(dir, "state", "durable", "v2", "ownership"), { recursive: true });
  abandon();

  // 1. A new task fills the only slot while recovery waits to retry.
  await holdBriefly();
  const recovering = registry.recoverAbandoned();
  await registry.launch({ cwd: dir, id: "fresh", prompt: "work", tools: [] });
  await recovering;
  const active = registry.all().filter((w) => w.isActive).map((w) => w.id);
  assert.deepEqual(active, ["fresh"], `capacity 1 holds after the retry: ${active.join(", ")}`);

  // 2. Shutdown during the wait: nothing is registered afterwards. Free the slot first, so the
  //    claim does reach the busy lock and its retry.
  registry.loaded("fresh").state = "done";
  await holdBriefly();
  const late = registry.recoverAbandoned();
  await registry.suspendAll();
  await late;
  assert.equal(registry.loaded("abandoned"), undefined, "no recovery after shutdown began");
  console.log("  OK -> recovery retry re-reads capacity and shutdown");
} finally {
  await rm(dir, { recursive: true, force: true });
}
