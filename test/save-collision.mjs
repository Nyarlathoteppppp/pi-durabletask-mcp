import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveText } from "../dist/save.js";

const dir = await mkdtemp(join(tmpdir(), "pi-save-collision-"));
const now = Date.now;
try {
  Date.now = () => 123456789;
  const path = join(dir, "result.md");
  const texts = ["first complete report", "second complete report"];
  const results = await Promise.allSettled(texts.map((text) => saveText(path, text)));
  assert.ok(results.every((r) => r.status === "fulfilled"), "same-target saves in one millisecond must both succeed");
  assert.ok(texts.includes(await readFile(path, "utf8")), "last rename wins with one complete report");
  assert.deepEqual(await readdir(dir), ["result.md"], "no abandoned temporary files");
  console.log("  OK -> simultaneous same-target saves do not share temporary files");
} finally { Date.now = now; await rm(dir, { recursive: true, force: true }); }
