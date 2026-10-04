import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Two processes claiming one abandoned job at the same instant must not both back off.
if (process.argv[2] === "claim") {
  const { claimAbandonedSettled } = await import("../dist/durable.js");
  while (Date.now() < Number(process.argv[3])) { /* start together */ }
  const claimed = (await claimAbandonedSettled(() => ({ excludeIds: new Set(), limit: 1 }))).length;
  process.stdout.write(String(claimed));
  // Hold ownership past the other claimer's retry window, so a second owner would be concurrent.
  // Awaited, so a claimer never falls through into the parent's flow below.
  await new Promise((resolve) => setTimeout(resolve, claimed ? 800 : 0));
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), "pi-delegate-claim-race-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: join(dir, "state") };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, ...args], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`claimer exited ${code}`)));
});
try {
  await mkdir(join(dir, "agent"), { recursive: true });
  // Create the catalog, then add one unfinished job that no process owns.
  await run(["claim", "0"]);
  const catalog = new DatabaseSync(join(dir, "state", "durable", "v2", "catalog.sqlite"));
  catalog.prepare("INSERT INTO jobs (key, pid, agent_dir, options, prompt) VALUES (?, 0, ?, ?, 'x')")
    .run("00000000-0000-4000-8000-00000000c1a1", join(dir, "agent"), JSON.stringify({ id: "raced" }));
  catalog.close();
  let unclaimed = 0;
  for (let round = 0; round < 20; round++) {
    const goAt = String(Date.now() + 400);
    const claims = (await Promise.all([run(["claim", goAt]), run(["claim", goAt])])).map(Number);
    assert.ok(claims.reduce((a, b) => a + b) <= 1, "never two owners");
    if (claims[0] + claims[1] === 0) unclaimed++;
  }
  assert.equal(unclaimed, 0, `rounds where both claimers backed off: ${unclaimed}/20`);
  console.log("  OK -> simultaneous claimers: exactly one owner in every round");
} finally {
  await rm(dir, { recursive: true, force: true });
}
