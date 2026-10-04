import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// History eviction can start unloading a session between a lookup's call and its first step.
// The lookup must still find it (or wait for the unload), not report it unknown.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-unload-race-"));
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: join(dir, "state"),
  PI_DELEGATE_HISTORY: "1" });
await mkdir(join(dir, "agent"), { recursive: true });
const durable = await import("../dist/durable.js");
const registry = await import("../dist/registry.js");
const { PiWorker } = await import("../dist/pi/worker.js");
const core = await import("../dist/core.js");
PiWorker.recover = async (options, _prompt, _key, worker) => { worker.state = options.id === "busy" ? "running" : "done"; return worker; };
try {
  durable.claimAbandoned(new Set(), 0); // creates the catalog
  const db = new DatabaseSync(join(dir, "state", "durable", "v2", "catalog.sqlite"));
  const add = db.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at) VALUES (?, 0, ?, ?, 'x', ?)");
  const options = (id) => JSON.stringify({ id, cwd: dir, tools: [], maxTurns: 5, maxDurationMs: 60000 });
  add.run("00000000-0000-4000-8000-0000000000b1", join(dir, "agent"), options("busy"), null);
  add.run("00000000-0000-4000-8000-0000000000f1", join(dir, "agent"), options("done"), Date.now());
  db.close();
  // A running session fills the history of one, so the finished one is next to be evicted.
  await registry.recoverAbandoned();
  assert.equal(registry.loaded("busy")?.state, "running");

  await registry.resolve("done");
  const lookup = registry.resolve("done");
  registry.evictHistory(); // starts unloading "done" while the lookup is under way
  assert.equal((await lookup).id, "done");

  await new Promise((resolve) => setTimeout(resolve, 50)); // let the unload finish
  await registry.resolve("done");
  const forgetting = registry.forget("done");
  registry.evictHistory();
  await forgetting;
  assert.equal(durable.storedIdInUse("done"), false, "forget deleted it");

  // forget while this process is still loading the session waits for the load.
  const again = new DatabaseSync(join(dir, "state", "durable", "v2", "catalog.sqlite"));
  again.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at) VALUES (?, 0, ?, ?, 'x', ?)")
    .run("00000000-0000-4000-8000-0000000000f2", join(dir, "agent"), options("loading"), Date.now());
  again.close();
  const loadingIt = registry.resolve("loading");
  await registry.forget("loading");
  await loadingIt;
  assert.equal(durable.storedIdInUse("loading"), false, "forget deleted the one being loaded");

  // A follow_up awaiting the same load must not execute on a worker forget already removed.
  const last = new DatabaseSync(join(dir, "state", "durable", "v2", "catalog.sqlite"));
  last.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at) VALUES (?, 0, ?, ?, 'x', ?)")
    .run("00000000-0000-4000-8000-0000000000f3", join(dir, "agent"), options("forget-followup"), Date.now());
  last.close();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const closing = Promise.withResolvers(), closeReleased = Promise.withResolvers();
  let disposed = false, executions = 0;
  PiWorker.recover = async (_options, _prompt, _key, worker) => {
    worker.state = "done";
    worker.nativeMcp = true;
    worker.session = {
      extensionRunner: { emit: async () => { closing.resolve(); await closeReleased.promise; } },
      dispose: () => { disposed = true; },
    };
    worker.followUp = async () => { executions++; return { sessionId: worker.id }; };
    entered.resolve();
    await release.promise;
    return worker;
  };
  const following = core.followUp("forget-followup", "continue");
  const rejected = assert.rejects(following, /forgotten|unloaded|Unknown sessionId/);
  await entered.promise;
  const deleted = core.forgetSession("forget-followup");
  release.resolve();
  await closing.promise;
  await rejected;
  assert.equal(durable.storedIdInUse("forget-followup"), true, "cleanup finishes before deleting persistent state");
  closeReleased.resolve();
  await deleted;
  assert.equal(disposed, true, "forget disposes the worker obtained after awaiting its load");
  assert.equal(executions, 0, "a stale reference must not start a follow_up");
  assert.equal(durable.storedIdInUse("forget-followup"), false);

  // Check the loaded worker's actual activity after the await, rather than the earlier lookup.
  const activeDb = new DatabaseSync(join(dir, "state", "durable", "v2", "catalog.sqlite"));
  activeDb.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt, finished_at) VALUES (?, 0, ?, ?, 'x', ?)")
    .run("00000000-0000-4000-8000-0000000000f4", join(dir, "agent"), options("loading-active"), Date.now());
  activeDb.close();
  const activeEntered = Promise.withResolvers(), activeRelease = Promise.withResolvers();
  PiWorker.recover = async (_options, _prompt, _key, worker) => {
    worker.state = "running";
    activeEntered.resolve(); await activeRelease.promise;
    return worker;
  };
  const activeLoad = registry.resolve("loading-active");
  await activeEntered.promise;
  const activeForget = assert.rejects(core.forgetSession("loading-active"), /Call abort first/);
  activeRelease.resolve();
  const active = await activeLoad;
  await activeForget;
  assert.equal(registry.loaded(active.id), active);
  assert.equal(durable.storedIdInUse(active.id), true);
  await active.abort();
  await core.forgetSession(active.id);
  console.log("  OK -> resolve and forget find a session that eviction starts unloading meanwhile");
} finally {
  await rm(dir, { recursive: true, force: true });
}
