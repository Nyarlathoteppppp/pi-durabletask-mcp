import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const compile = async (name) => new AsyncFunction("tools", "store", "load", "text", await readFile(`docs/examples/${name}.js`, "utf8"));
const research = await compile("research-codemode"), inspect = await compile("research-inspect");
const state = new Map(), output = [];
const store = (key, value) => state.set(key, value), load = (key) => state.get(key), text = (value) => output.push(value);
const error = { isError: true, content: [{ type: "text", text: "models error content is not evidence" }] };
let fetches = 0;
await research({ mcp__exa__web_search_exa: async () => error,
  mcp__exa__web_fetch_exa: async () => { fetches++; } }, store, load, text);
assert.equal(fetches, 0, "MCP error responses do not count as successful searches");
assert.ok(load("research.searches").every((s) => !s.ok && s.result === error));
output.length = 0;
await research({ mcp__exa__web_search_exa: async () => ({ content: [] }),
  mcp__exa__web_fetch_exa: async () => ++fetches === 1 ? error : { content: [{ type: "text", text: "tools are callable" }] } }, store, load, text);
assert.equal(load("research.pages")[0].ok, false);
assert.equal(load("research.pages")[1].ok, true);
// Legacy stored receipts can contain an incorrectly marked error page.
load("research.pages")[0].ok = true;
output.length = 0;
await inspect({}, store, load, text);
assert.equal(output[0].ok, false);
assert.equal(output[0].excerpts, undefined);
assert.match(output[1].excerpts, /tools are callable/);
// Refill: never more than SLOTS children at once, a freed slot is filled at once, a full server is retried.
const refill = await compile("coordinator-refill");
const live = new Set(), launched = [];
let peak = 0, refused = 0;
const refilled = await refill({
  delegate_start_batch: async ({ taskIndexes: [index] }) => {
    if (index === 3 && refused++ === 0) throw new Error("Delegate concurrency limit is 4");
    const id = `child-${index}`;
    live.add(id); launched.push(index); peak = Math.max(peak, live.size);
    return { started: 1, sessionIds: [id] };
  },
  delegate_wait: async ({ sessionIds, until }) => {
    assert.equal(until, "settled");
    const done = sessionIds[0]; // the first running child finishes; the others keep running
    live.delete(done);
    return { settled: [done], sessions: sessionIds.map((sessionId) => ({ sessionId, pendingQuestions: 0 })) };
  },
}, store, load, text);
assert.deepEqual(launched, [0, 1, 2, 3, 4, 5]);
assert.equal(peak, 3);
assert.deepEqual(refilled, { finished: launched.map((i) => `child-${i}`), running: [], unlaunched: [] });
for (const name of ["coordinator-evidence", "evidence-revisit", "discover-tools"]) await compile(name);
console.log("  OK -> research scripts retain MCP errors without presenting them as evidence; Codemode recipes compile as async bodies; refill keeps slots full");
