// Fault injection belongs in the test process, not in the production server.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DurableJob } from "../dist/durable.js";
const save = DurableJob.prototype.save;
DurableJob.prototype.save = async function (checkpoint) {
  await save.call(this, checkpoint);
  if (process.env.TEST_CRASH_ON_RECOVERY && checkpoint.recoveryInput) {
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  }
  // Die once the final answer is saved, before the task's terminal commit.
  if (process.env.TEST_CRASH_AFTER_ANSWER && checkpoint.snapshot.lastText === process.env.TEST_CRASH_AFTER_ANSWER) {
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  }
  const crashFile = process.env.TEST_RECOVERY_CRASH;
  if (crashFile && checkpoint.recoveryInput && !existsSync(crashFile)) {
    writeFileSync(crashFile, JSON.stringify(checkpoint));
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  }
  const nestedBarrier = process.env.TEST_NESTED_TOOL_BARRIER;
  if (nestedBarrier && checkpoint.snapshot.toolCalls.some(call => call.parentToolCallId && call.state === "running") &&
      !existsSync(nestedBarrier + ".started")) {
    writeFileSync(nestedBarrier + ".started", "committed");
    while (!existsSync(nestedBarrier + ".release")) await new Promise(resolve => setTimeout(resolve, 10));
  }
  const barrier = process.env.TEST_TOOL_BARRIER;
  if (barrier && checkpoint.snapshot.toolCalls.some((call) => call.state === "running") &&
    !existsSync(barrier + ".started")) {
    writeFileSync(barrier + ".started", "committed");
    while (!existsSync(barrier + ".release")) await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
// Die right after a follow-up task commits, before anything else runs.
const begin = DurableJob.prototype.begin;
DurableJob.prototype.begin = async function (prompt, checkpoint, execute, recover = false) {
  if (process.env.TEST_CRASH_AFTER_FOLLOWUP_COMMIT && this.taskId && !recover) {
    const root = this.harness.root.bind(this.harness);
    this.harness.root = async (ctx) => {
      const handle = await root(ctx);
      const commit = handle.commit.bind(handle);
      handle.commit = async (...args) => {
        await commit(...args);
        process.kill(process.pid, "SIGKILL");
        await new Promise(() => {});
      };
      return handle;
    };
  }
  return begin.call(this, prompt, checkpoint, execute, recover);
};
// Hold a recovery between reading its checkpoint and reopening the store as executor.
const close = DurableJob.prototype.close;
DurableJob.prototype.close = async function (release = true) {
  await close.call(this, release);
  const closeBarrier = process.env.TEST_CLOSE_BARRIER;
  if (closeBarrier && !release && !existsSync(closeBarrier + ".started")) {
    writeFileSync(closeBarrier + ".started", "closed");
    while (!existsSync(closeBarrier + ".release")) await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
// Die after a run's terminal commit, before its finished state reaches the catalog.
const recordFinal = DurableJob.prototype.recordFinal;
DurableJob.prototype.recordFinal = function (snapshot) {
  if (process.env.TEST_CRASH_BEFORE_FINAL && snapshot.turns >= Number(process.env.TEST_CRASH_BEFORE_FINAL)) {
    process.kill(process.pid, "SIGKILL");
  }
  return recordFinal.call(this, snapshot);
};

// Make one provider's credentials fail to resolve, as an expired OAuth refresh would. The
// provider is named by TEST_BROKEN_PROVIDER, or read on each call from TEST_BROKEN_PROVIDER_FILE
// so a test can break auth while the server runs.
if (process.env.TEST_BROKEN_PROVIDER || process.env.TEST_BROKEN_PROVIDER_FILE) {
  const { getRuntime } = await import("../dist/pi/runtime.js");
  const runtime = await getRuntime();
  const getAuth = runtime.getAuth.bind(runtime);
  const broken = () => process.env.TEST_BROKEN_PROVIDER ??
    (existsSync(process.env.TEST_BROKEN_PROVIDER_FILE) ? readFileSync(process.env.TEST_BROKEN_PROVIDER_FILE, "utf8").trim() : undefined);
  runtime.getAuth = async (provider, options) => {
    if (provider === broken()) throw new Error(`OAuth refresh failed for ${provider}: simulated`);
    return getAuth(provider, options);
  };
}
await import("../dist/index.js");
