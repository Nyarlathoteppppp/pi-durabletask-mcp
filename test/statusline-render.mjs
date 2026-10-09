import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "pi-statusline-render-"));
const file = join(directory, `${process.pid}.json`);
const previousDirectory = process.env.PI_DELEGATE_STATE_DIR;
const originalExec = childProcess.execFileSync;
process.env.PI_DELEGATE_STATE_DIR = directory;
// ancestors() includes our own pid before consulting ps. Stop there without
// spawning an external command; everything else uses the real state reader.
childProcess.execFileSync = (command, args) => {
  assert.equal(command, "ps");
  assert.deepEqual(args, ["-o", "ppid=", "-p", String(process.pid)]);
  return "1\n";
};
syncBuiltinESMExports();

try {
  const { segment } = await import("../dist/statusline/render.js");
  const session = (id, state, extra = {}) => ({
    id, label: id, state, model: "actual-provider/actual-model", thinking: "off",
    cwd: "/workspace/original", turns: 2, questions: 0,
    startedAt: new Date(Date.now() - 5000).toISOString(), ...extra,
  });
  const write = (sessions, hostPid = process.pid) => writeFileSync(file, JSON.stringify({
    pid: process.pid, hostPid, updatedAt: new Date().toISOString(), sessions,
  }));
  const render = (cwd = "/workspace/original") => {
    const before = readFileSync(file, "utf8");
    const output = segment(cwd).replace(/\u001b\[\d+m/g, "");
    assert.equal(readFileSync(file, "utf8"), before, "render must not rewrite state");
    assert.deepEqual(readdirSync(directory), [`${process.pid}.json`]);
    assert.ok(!output.includes("undefined"));
    return output;
  };

  write([
    session("hidden-id", "starting", { label: "boot" }),
    session("work", "running", { model: "other-provider/other-model", thinking: "high" }),
  ]);
  let output = render();
  assert.match(output, /boot·starting·actual-provider\/actual-model·thinking:off·t2/);
  assert.match(output, /work·running·other-provider\/other-model·thinking:high·t2/);
  assert.ok(!output.includes("hidden-id"), "prefer the task label over its id");
  assert.match(output, /·\d+s/);
  assert.match(render("/workspace/changed"), /boot·starting/,
    "current-host attribution must survive an ordinary cwd change");

  write([
    session("run-one", "running"),
    session("run-two", "running"),
    session("run-three", "running"),
    session("question", "running", { questions: 2 }),
    session("past", "done"),
  ]);
  output = render();
  assert.match(output, /question·running·waiting questions/);
  assert.ok(output.indexOf("question·") < output.indexOf("run-one·"));
  assert.match(output, /run-two·running/);
  assert.ok(!output.includes("run-three"), "at most three active details");
  assert.match(output, /\+1/);
  assert.match(output, /\?1 waiting/);
  assert.match(output, /✓1/);
  assert.ok(!output.includes("past·"), "terminal identities do not displace active tasks");

  write([session("answer-me", "done", { questions: 1 })]);
  assert.match(render(), /answer-me·done·waiting questions/,
    "pending answers remain visible without a running delegate");

  write([
    session("done-one", "done"), session("done-two", "done"), session("done-three", "done"),
    session("failed-task", "error"), session("cancel-task", "aborted"),
  ]);
  output = render();
  assert.match(output, /failed-task·error·actual-provider\/actual-model·thinking:off/);
  assert.match(output, /cancel-task·aborted·actual-provider\/actual-model·thinking:off/);
  assert.ok(!output.includes("done-one") && !output.includes("done-two") && !output.includes("done-three"),
    "terminal details are capped at two");
  assert.match(output, /✓3/);
  assert.match(output, /✗1/);
  assert.match(output, /⊘1 aborted/);
  for (const state of ["done", "error", "aborted"]) {
    write([session("only-task", state)]);
    assert.ok(render().includes(`only-task·${state}·actual-provider/actual-model·thinking:off`));
  }

  // Old/sparse publications must not acquire a fabricated model or thinking level.
  write([{ id: "id-fallback", state: "starting", cwd: "/workspace/original" }]);
  output = render();
  assert.equal(output, "π ▸ id-fallback·starting");
  write([{ id: "id-fallback", state: "done", cwd: "/workspace/original" }]);
  assert.equal(render(), "π id-fallback·done ✓1");

  write([session("foreign-task", "running")], -1);
  assert.equal(render(), "", "another host on the same cwd must be isolated");
  assert.equal(render("/workspace/changed"), "");
  write([session("legacy-task", "running")]);
  // A missing hostPid retains the existing legacy cwd fallback.
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  delete legacy.hostPid;
  writeFileSync(file, JSON.stringify(legacy));
  assert.match(render(), /legacy-task·running/);
  assert.equal(render("/workspace/changed"), "");
  write([]);
  assert.equal(render(), "");
  console.log("statusline-render: OK");
} finally {
  childProcess.execFileSync = originalExec;
  syncBuiltinESMExports();
  if (previousDirectory === undefined) delete process.env.PI_DELEGATE_STATE_DIR;
  else process.env.PI_DELEGATE_STATE_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
}
