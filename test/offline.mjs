import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "pi-delegate-tests-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_DELEGATE_") && name !== "PI_CODING_AGENT_DIR"));
Object.assign(env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: join(dir, "state") });
try {
  for (const [file, ...args] of [
    ["launch", "node", "dist/index.js"], ["policy"], ["lifecycle"], ["workspace"], ["regressions"], ["integration"], ["recovery"], ["pause-race"],
  ]) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [`test/${file}.mjs`, ...args], { env, stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (code !== 0) throw new Error(`${file} failed (${code})`);
  }
} finally { await rm(dir, { recursive: true, force: true }); }
