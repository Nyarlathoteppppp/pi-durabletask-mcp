import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "pi-delegate-tests-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_DELEGATE_") && name !== "PI_CODING_AGENT_DIR"));
Object.assign(env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: join(dir, "state") });
// The search tests need ripgrep. CI installs it; locally, use the copy Pi downloads for its own grep.
const piBin = join(homedir(), ".pi", "agent", "bin");
if (existsSync(join(piBin, "rg"))) env.PATH = `${piBin}${delimiter}${env.PATH ?? ""}`;
// `node test/offline.mjs regressions claim-race` runs only those groups.
const only = new Set(process.argv.slice(2));
try {
  for (const [file, ...args] of [
    ["start-cancel"], ["wait-finalization"], ["worker-run"],
    ["http"], ["launch", "node", "dist/index.js"], ["policy"], ["default-model-policy", "allow"], ["default-model-policy", "deny"], ["default-model-policy", "scope"], ["lifecycle"], ["workspace"], ["regressions"], ["result-relationships"], ["integration"], ["memory-checkpoint"], ["core"], ["recovery"], ["ownership"], ["claim-race"], ["recovery-capacity"], ["recovery-shutdown"], ["retention"], ["retention-race"], ["orphan-gc"], ["usability"], ["handoff"], ["unload-race"], ["final-turn"], ["attachments"], ["liveness"], ["answer-state"], ["codemode"], ["save"], ["review-claims"], ["pause-race"], ["native-mcp"], ["native-recovery"],
  ].filter(([file]) => !only.size || only.has(file))) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [`test/${file}.mjs`, ...args], { env, stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (code !== 0) throw new Error(`${file} failed (${code})`);
  }
} finally { await rm(dir, { recursive: true, force: true }); }
