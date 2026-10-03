import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Use the SDK shipped with the required global Pi install. Updating Pi replaces
// that directory, so new bridge processes follow it without a second npm update.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const source = join(globalRoot, "@earendil-works", "pi-coding-agent");
const target = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(source, "package.json"))) {
  throw new Error("Install Pi globally first: npm install -g @earendil-works/pi-coding-agent");
}
if (!existsSync(target) || realpathSync(target) !== realpathSync(source)) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, "dir");
}
const { version } = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
console.log(`pi-durabletask-mcp SDK -> global Pi ${version} (${source})`);
