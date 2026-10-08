import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "@earendil-works/pi-coding-agent";
const bridgeRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function managedSource(root) {
  const markerPath = join(root, "managed-install.json");
  if (!existsSync(markerPath)) return;
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") {
    throw new Error(`Unsupported managed Pi installation: ${root}`);
  }
  const version = readFileSync(join(root, "current-version"), "utf8").trim();
  return join(root, "releases", version, "node_modules", packageName);
}

function findManagedSource() {
  // The official launcher exports this, but MCP hosts usually do not inherit it.
  if (process.env.PI_MANAGED_INSTALL_ROOT) {
    const source = managedSource(process.env.PI_MANAGED_INSTALL_ROOT);
    if (!source) throw new Error(`No managed Pi installation at ${process.env.PI_MANAGED_INSTALL_ROOT}`);
    return source;
  }
  for (const bin of (process.env.PATH ?? "").split(delimiter)) {
    const command = join(bin, "pi");
    try { accessSync(command, constants.X_OK); } catch { continue; }
    const commandDir = dirname(realpathSync(command));
    // Official launchers live at install/pi or <agentDir>/bin/pi (possibly symlinked).
    const source = managedSource(commandDir) ?? managedSource(join(dirname(commandDir), "install"));
    if (source) return source;
    break; // Inspect the selected pi, not another executable later on PATH.
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return managedSource(join(agentDir, "install"));
}

export function linkPiSdk({ root = bridgeRoot, managedOnly = false, quiet = false } = {}) {
  let source = findManagedSource();
  const managed = !!source;
  // npm updates replace a stable directory; no npm subprocess is needed at startup.
  if (!source && managedOnly) return;
  if (!source) {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    source = join(globalRoot, packageName);
  }
  if (!existsSync(join(source, "package.json"))) {
    throw new Error(`Pi SDK not found at ${source}. Install Pi first: https://pi.dev/install.sh`);
  }
  const target = join(root, "node_modules", packageName);
  if (!existsSync(target) || realpathSync(target) !== realpathSync(source)) {
    mkdirSync(dirname(target), { recursive: true });
    // Initial directory conversion belongs to postinstall/sdk:link. Doing it during
    // concurrent MCP starts would leave a gap while another process imports the SDK.
    if (existsSync(target) && !lstatSync(target).isSymbolicLink()) {
      if (managedOnly) throw new Error("Pi SDK setup is incomplete. Run npm run sdk:link in the bridge directory before starting MCP.");
      rmSync(target, { recursive: true, force: true });
    }
    // Release switches replace the existing symlink atomically.
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      symlinkSync(source, temporary, "dir");
      renameSync(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
  }
  const { version } = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (!quiet) console.log(`pi-durabletask-mcp SDK -> ${managed ? "managed" : "global"} Pi ${version} (${source})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) linkPiSdk();
