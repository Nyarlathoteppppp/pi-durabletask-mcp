import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), "pi-sdk-link-"));
const root = join(dir, "bridge");
const agent = join(dir, "agent");
const managed = join(agent, "install");
const bin = join(dir, "bin");
const globalRoot = join(dir, "global");
const name = "@earendil-works/pi-coding-agent";
const env = { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agent };
delete env.PI_MANAGED_INSTALL_ROOT;
const command = (args, overrides = {}) => exec(process.execPath, args, { cwd: root, env: { ...env, ...overrides } });
async function sdk(path, version) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name, version, type: "module", exports: "./index.js" }));
  await writeFile(join(path, "index.js"), `export const version = ${JSON.stringify(version)};\n`);
}
async function release(version) {
  const path = join(managed, "releases", version, "node_modules", name);
  await sdk(path, version);
  await writeFile(join(managed, "current-version"), `${version}\n`);
  return path;
}
try {
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "dist"));
  await mkdir(bin);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await copyFile("scripts/link-pi-sdk.mjs", join(root, "scripts", "link-pi-sdk.mjs"));
  await copyFile("dist/index.js", join(root, "dist", "index.js"));
  await writeFile(join(root, "dist", "main.js"), `import {version} from "${name}"; console.log(version);`);
  await writeFile(join(bin, "npm"), `#!${process.execPath}\nconsole.log(${JSON.stringify(globalRoot)});\n`, { mode: 0o755 });
  await writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const globalSdk = join(globalRoot, name);
  await sdk(globalSdk, "1.0.4");
  await command(["scripts/link-pi-sdk.mjs"]);
  assert.equal(await realpath(join(root, "node_modules", name)), await realpath(globalSdk));
  assert.equal((await command(["dist/index.js"])).stdout.trim(), "1.0.4");

  await mkdir(managed, { recursive: true });
  await writeFile(join(managed, "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
  const first = await release("1.1.0");
  // npm --ignore-scripts leaves a physical SDK directory; complete the documented
  // sdk:link step before starting hosts instead of deleting it concurrently at startup.
  await rm(join(root, "node_modules", name));
  await sdk(join(root, "node_modules", name), "1.0.0");
  await assert.rejects(command(["dist/index.js"]), (err) => err.stderr.includes("npm run sdk:link"));
  await command(["scripts/link-pi-sdk.mjs"]);
  assert.equal(await realpath(join(root, "node_modules", name)), await realpath(first));
  assert.equal((await command(["dist/index.js"])).stdout.trim(), "1.1.0", "bootstrap must not print linker output on MCP stdout");

  // Retention can delete the release behind our old symlink before the next MCP start.
  const second = await release("1.1.1");
  await rm(dirname(dirname(dirname(first))), { recursive: true, force: true });
  await writeFile(join(bin, "npm"), `#!${process.execPath}\nprocess.exit(99);\n`, { mode: 0o755 });
  const starts = await Promise.all(Array.from({ length: 4 }, () => command(["dist/index.js"])));
  assert.ok(starts.every(({ stdout }) => stdout.trim() === "1.1.1"));
  assert.equal(await realpath(join(root, "node_modules", name)), await realpath(second));

  // A custom installation is discoverable from the real launcher behind a PATH symlink.
  const launcher = join(agent, "bin", "pi");
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await rm(join(bin, "pi"));
  await symlink(launcher, join(bin, "pi"));
  const otherAgent = join(dir, "other-auth-dir");
  assert.equal((await command(["dist/index.js"], { PI_CODING_AGENT_DIR: otherAgent })).stdout.trim(), "1.1.1");
  assert.equal((await command(["dist/index.js"], { PI_MANAGED_INSTALL_ROOT: managed, PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: otherAgent })).stdout.trim(), "1.1.1");

  await writeFile(join(managed, "current-version"), "missing\n");
  await assert.rejects(command(["dist/index.js"]), (err) => err.stderr.includes("Pi SDK not found"));
  assert.equal(JSON.parse(await readFile(join(second, "package.json"), "utf8")).version, "1.1.1");
  console.log("  OK -> npm/managed SDK discovery, silent bootstrap, deleted old release, concurrent starts, custom launcher and broken managed install");
} finally { await rm(dir, { recursive: true, force: true }); }
