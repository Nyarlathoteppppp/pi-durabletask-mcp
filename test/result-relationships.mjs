import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiWorker, repairEntries } from "../dist/pi/worker.js";

const worker = new PiWorker({ cwd: process.cwd(), tools: [], maxTurns: 8, maxDurationMs: 10000 });
const manager = SessionManager.inMemory(process.cwd());
manager.appendMessage({ role: "assistant", content: [
  { type: "toolCall", id: "outer", name: "codemode", arguments: { code: "interrupted" } },
], api: "openai-completions", provider: "test", model: "one", timestamp: 1, stopReason: "toolUse",
usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const result = (text, parentToolCallId) => ({ name: "echo", content: [{ type: "text", text }],
  isError: false, parentToolCallId });
// Opaque child IDs and an unrelated ID sharing the old prefix deliberately disagree.
Object.assign(worker.results, {
  "opaque-child": result("CHILD_COMMITTED", "outer"),
  "opaque-grandchild": result("GRANDCHILD_COMMITTED", "pending-child"),
  "outer/unrelated": result("OTHER_PARENT", "another-root"),
});
worker.toolCalls.push({ id: "pending-child", parentToolCallId: "outer", seq: 1,
  name: "nested-wrapper", args: undefined, state: "running" });
const checkpoint = { phase: "execute", entries: [manager.getHeader(), ...manager.getEntries()],
  snapshot: worker.snapshot({ verbose: true }), inputStarted: true, steering: [], results: worker.results };
const repaired = SessionManager.inMemory(process.cwd(), undefined, repairEntries(checkpoint))
  .buildSessionContext().messages.at(-1);
assert.equal(repaired.role, "toolResult");
const text = JSON.stringify(repaired.content);
assert.match(text, /CHILD_COMMITTED/);
assert.match(text, /GRANDCHILD_COMMITTED/);
assert.doesNotMatch(text, /OTHER_PARENT/);
assert.match(text, /do not replay/);

worker.results.outer = result("PARENT_COMMITTED");
worker.clearResults("outer");
assert.deepEqual(Object.keys(worker.results), ["outer/unrelated"],
  "parent commit clears all descendants, including through a pending ancestor, and retains unrelated staging");
console.log("  OK -> result recovery and cleanup use parent relationships across opaque IDs and multiple nesting levels");
