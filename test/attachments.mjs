import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Files the caller attaches are read by the server and appended to the prompt, so a delegate can
// review a diff the caller wrote anywhere, without the caller copying it into its own output.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-attachments-"));
// Pi's credentials live in PI_CODING_AGENT_DIR when it is set, not only under ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
const { withAttachments } = await import("../dist/attachments.js");
try {
  const diff = join(dir, "change.diff");
  await writeFile(diff, "--- a/x\n+++ b/x\n+```js\n+code\n+```\n");
  const prompt = await withAttachments("Review the attached diff.", [diff]);
  assert.ok(prompt.startsWith("Review the attached diff."));
  assert.ok(prompt.includes(JSON.stringify(diff)), "names the file");
  assert.ok(prompt.includes("+code"), "includes its content");
  // The fence is longer than any backtick run inside, so content cannot close it.
  assert.ok(prompt.includes("````\n--- a/x"), "fence longer than the content's backticks");
  assert.equal(await withAttachments("plain", undefined), "plain");
  assert.equal(await withAttachments("plain", []), "plain");

  const refuse = async (paths, pattern) => assert.rejects(() => withAttachments("x", paths), pattern);
  await refuse(["relative.txt"], /absolute/);
  await refuse([join(dir, "missing.txt")], /cannot read/);
  await refuse([dir], /not a regular file/);
  await mkdir(join(dir, "repo"));
  await writeFile(join(dir, "repo", ".env"), "TOKEN=secret\n");
  await refuse([join(dir, "repo", ".env")], /secret/);
  await symlink(join(dir, "repo", ".env"), join(dir, "innocent.txt"));
  await refuse([join(dir, "innocent.txt")], /secret/);
  await writeFile(join(dir, "credentials.txt"), "FAKE_TOKEN=secret\n");
  await symlink(join(dir, "credentials.txt"), join(dir, ".env"));
  await refuse([join(dir, ".env")], /secret/);
  const { assertToolPathsAllowed } = await import("../dist/secrets.js");
  assert.throws(() => assertToolPathsAllowed("read", { path: join(dir, ".env") }, dir), /private credential/);
  await writeFile(join(dir, "repo", "notes.txt"), "FAKE_TOKEN=secret\n");
  await symlink(join(dir, "repo"), join(dir, ".ssh"));
  await refuse([join(dir, ".ssh", "notes.txt")], /secret/);
  await mkdir(join(dir, "pi-agent"));
  await writeFile(join(dir, "pi-agent", "auth.json"), "{\"token\":\"secret\"}");
  await refuse([join(dir, "pi-agent", "auth.json")], /secret/);
  // Many separate backtick runs must not overflow Math.max's argument list.
  await writeFile(join(dir, "ticks.txt"), "`a".repeat(131072));
  assert.ok((await withAttachments("x", [join(dir, "ticks.txt")])).includes("``\n`a`a"));
  await writeFile(join(dir, "binary.bin"), Buffer.from([0x41, 0x00, 0x42]));
  await refuse([join(dir, "binary.bin")], /binary/);
  await writeFile(join(dir, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await refuse([join(dir, "latin1.txt")], /UTF-8/);
  await writeFile(join(dir, "big.txt"), "x".repeat(256 * 1024 + 1));
  await refuse([join(dir, "big.txt")], /256 KiB/);
  const parts = await Promise.all([0, 1, 2, 3, 4].map(async (i) => {
    const file = join(dir, `part${i}.txt`);
    await writeFile(file, "y".repeat(250 * 1024));
    return file;
  }));
  await refuse(parts, /1 MiB/);
  await refuse(Array.from({ length: 21 }, () => diff), /at most 20/);
  console.log("  OK -> attachments: appended with a safe fence; relative, missing, non-file, secret, binary, non-UTF-8 and oversized refused");
} finally {
  await rm(dir, { recursive: true, force: true });
}
