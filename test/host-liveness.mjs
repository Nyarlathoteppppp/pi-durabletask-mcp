import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = new URL("../dist/index.js", import.meta.url).href;
const watchMs = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exited = (child) => new Promise((resolve) => {
  child.once("exit", resolve);
  child.once("error", resolve);
});

async function check(mode) {
  const dir = await mkdtemp(join(tmpdir(), "pi-delegate-host-"));
  const stateDir = join(dir, "state");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_DELEGATE_") && name !== "PI_CODING_AGENT_DIR"));
  Object.assign(env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: stateDir,
    PI_DELEGATE_HOST_WATCH_MS: String(mode === "birth" ? 30000 : watchMs) });
  const errors = [];
  // This writer outlives the host: killing the host cannot deliver EOF to the server.
  const keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env, stdio: ["ignore", "pipe", "ignore"] });
  const keeperExited = exited(keeper);
  keeper.on("error", (error) => errors.push(error));
  const source = `
    import { writeSync } from "node:fs";
    const original = process.ppid;
    const report = (value) => writeSync(1, JSON.stringify(value) + "\\n");
    process.on("exit", (code) => report({ fixture: "exit", code }));
    report({ fixture: "boot", pid: process.pid });
    if (${JSON.stringify(mode)} === "birth") {
      // Do not load the entry point until the real parent has gone.
      while (process.ppid === original) await new Promise((resolve) => setTimeout(resolve, 10));
      report({ fixture: "orphan", ppid: process.ppid });
    }
    if (${JSON.stringify(mode)} === "reparented") {
      // Simulate reuse of the old host PID: kill(pid, 0) alone must not keep us alive.
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => pid === original && signal === 0 ? true : kill(pid, signal);
    }
    if (${JSON.stringify(mode)} === "missing") {
      // Exercise the kill-probe fallback independently of the parent-change check.
      Object.defineProperty(process, "ppid", { value: original });
    }
    await import(${JSON.stringify(entry)});
    report({ fixture: "ready" });
  `;
  const host = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(source)}], { stdio: "inherit" });
    child.on("error", () => process.exit(1));
    child.on("exit", (code) => process.exit(code ?? 1));
  `], { env, detached: true, stdio: [keeper.stdout, "pipe", "pipe"] });
  const hostExited = exited(host);
  host.on("error", (error) => errors.push(error));
  let output = "", stderr = "", pending = "";
  const messages = [];
  host.stdout.on("data", (chunk) => {
    output += chunk;
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try { messages.push(JSON.parse(line)); } catch {}
    }
  });
  host.stderr.on("data", (chunk) => { stderr += chunk; });
  const waitUntil = async (predicate, timeout, message) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (errors.length) throw errors[0];
      assert.ok(Date.now() < deadline, `${message}\nstdout: ${output}\nstderr: ${stderr}`);
      await sleep(20);
    }
  };
  const saw = (fixture) => messages.find((message) => message.fixture === fixture);
  try {
    await waitUntil(() => saw("boot"), 15000, "server fixture did not boot");
    if (mode === "birth") {
      host.kill("SIGKILL");
      await hostExited;
      await waitUntil(() => saw("orphan"), 3000, "server was not reparented");
      if (saw("orphan").ppid !== 1) {
        console.log(`  SKIP -> orphan-at-birth adopted by subreaper ${saw("orphan").ppid}, not PID 1`);
        return;
      }
      if (process.platform === "darwin") {
        await waitUntil(() => host.stdout.readableEnded, 5000, "orphan-at-birth server did not exit promptly");
        assert.equal(saw("exit")?.code, 0, "orphan startup uses a clean shutdown");
        assert.ok(!existsSync(join(stateDir, "durable")), "orphan startup must not even open durable storage");
        assert.ok(!saw("ready"), "orphan startup must not connect the transport");
        console.log("  OK -> macOS orphan-at-birth exits before recovery with stdin still open");
      } else {
        await waitUntil(() => saw("ready"), 15000, "server with PID 1 parent did not finish startup");
        await sleep(2000);
        assert.ok(!host.stdout.readableEnded && !saw("exit"), "PID 1 may be a live MCP host; server must stay alive");
        console.log("  OK -> PID 1 parent does not prevent startup outside macOS");
      }
    } else {
      await waitUntil(() => saw("ready"), 15000, "server did not finish startup");
      await sleep(2 * watchMs);
      assert.ok(!host.stdout.readableEnded, "server must stay alive while its host lives");
      host.kill("SIGKILL");
      await hostExited;
      await waitUntil(() => host.stdout.readableEnded, 2 * watchMs + 500, `${mode} host was not detected by the watchdog`);
      assert.equal(saw("exit")?.code, 0, "host loss uses a clean shutdown");
      console.log(`  OK -> ${mode} host exits within two watchdog intervals with stdin still open`);
    }
    assert.equal(keeper.exitCode, null, "stdin writer must still be alive");
    assert.equal(keeper.signalCode, null, "stdin writer must not have been killed");
  } finally {
    // A separate process group also catches the server if startup failed before reporting its PID.
    try { if (host.pid) process.kill(-host.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") errors.push(error); }
    keeper.kill("SIGKILL");
    await Promise.all([hostExited, keeperExited]);
    host.stdout.destroy();
    host.stderr.destroy();
    keeper.stdout.destroy();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (errors.length) throw errors[0];
  }
}

if (process.platform === "win32") {
  console.log("  SKIP -> host reparenting tests require POSIX process groups");
} else {
  for (const mode of ["birth", "reparented", "missing"]) await check(mode);
}
