import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { blockedSecretPath } from "../dist/secrets.js";
import { resolveDelegateCwd } from "../dist/workspace.js";

await assert.rejects(() => resolveDelegateCwd(undefined), /cwd is required/);
await assert.rejects(() => resolveDelegateCwd("."), /absolute/);
await assert.rejects(() => resolveDelegateCwd("/"), /filesystem root/);
await assert.rejects(() => resolveDelegateCwd(homedir()), /home directory/);
const tmp = await resolveDelegateCwd("/tmp");
assert.ok(tmp.startsWith("/"));

const home = homedir();
assert.ok(blockedSecretPath(join(home, ".codex", "auth.json"), "/tmp"));
assert.ok(blockedSecretPath(join(home, ".ssh", "id_rsa"), "/tmp"));
assert.ok(blockedSecretPath(join(home, ".grok", "auth.json"), "/tmp"));
assert.ok(blockedSecretPath(join(home, ".pi", "agent", "auth.json"), "/tmp"));
assert.ok(blockedSecretPath(join("/tmp", ".env"), "/tmp"));
assert.equal(blockedSecretPath(join("/tmp", "README.md"), "/tmp"), undefined);

// A file that does not exist yet under a symlinked secret directory is still blocked.
{
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "pi-delegate-secret-link-"));
  const fakeHome = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
  mkdirSync(repo);
  symlinkSync(join(fakeHome, ".ssh"), join(repo, "link"));
  try {
    assert.ok(blockedSecretPath(join(repo, "link", "new-key"), repo, fakeHome), "symlinked parent, missing file");
    assert.ok(blockedSecretPath(join(repo, "link", "deeper", "new-key"), repo, fakeHome), "missing intermediate directory");
    assert.equal(blockedSecretPath(join(repo, "plain", "new-file"), repo, fakeHome), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log("  OK -> cwd and secret-path guards");
