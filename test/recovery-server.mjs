// Fault injection belongs in the test process, not in the production server.
import { existsSync, writeFileSync } from "node:fs";
import { DurableJob } from "../dist/durable.js";
const save = DurableJob.prototype.save;
DurableJob.prototype.save = async function (checkpoint) {
  await save.call(this, checkpoint);
  if (process.env.TEST_CRASH_ON_RECOVERY && checkpoint.recoveryInput) {
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
await import("../dist/index.js");
