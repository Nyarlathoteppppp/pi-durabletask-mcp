import assert from "node:assert/strict";
process.env.PI_DELEGATE_MAX_TURNS = "5";
process.env.PI_DELEGATE_MAX_DURATION_MS = "60000";
const { coordinatorSchema } = await import("../dist/coordinator.js");
const { startExecution } = await import("../dist/core.js");
const plan = coordinatorSchema.parse({ tasks: [{ prompt: "review" }] });
assert.equal(plan.tasks[0].maxTurns, 5);
assert.equal(plan.tasks[0].maxDurationMs, 60000);
assert.equal(plan.tasks[0].maxToolCalls, 12);
await assert.rejects(startExecution({ prompt: "x", cwd: process.cwd(), tools: ["read"], coordinator: { tasks: [{ prompt: "child" }] } }), /codemode/);
await assert.rejects(startExecution({ prompt: "x", cwd: process.cwd(), durable: true, coordinator: { tasks: [{ prompt: "child" }] } }), /memory-only/);
for (const task of [{ prompt: "x", maxTurns: 6 }, { prompt: "x", maxDurationMs: 60001 }, { prompt: "x", tools: ["write"] }, { prompt: "x", coordinator: { tasks: [] } }]) {
  assert.equal(coordinatorSchema.safeParse({ tasks: [task] }).success, false);
}
console.log("  OK -> coordinator direct-core policy and defaults respect configured budget ceilings");

// Use controllable startup to cover a duplicate dispatch while its first call is pending.
const { createCoordinatorTools } = await import("../dist/coordinator.js");
const starting = Promise.withResolvers();
let launches = 0;
const tools = createCoordinatorTools(coordinatorSchema.parse({ tasks: [{ prompt: "a" }, { prompt: "b" }] }), process.cwd(), {
  startBatch: async () => { if (++launches === 1) return starting.promise; return { requested: 1, started: 1, sessionIds: ["child-a"], sessions: [{ index: 0, sessionId: "child-a" }] }; },
  waitForMany: async () => ({ settled: [], pending: [], continueIds: [], sessions: [] }),
  getState: async () => { throw new Error("unexpected foreign lookup"); },
});
const started = tools[0].execute("first", { taskIndexes: [1, 0] });
await assert.rejects(tools[0].execute("duplicate", { taskIndexes: [1] }), /already dispatched/);
starting.resolve({ requested: 2, started: 1, sessionIds: ["child-b"], sessions: [{ index: 0, sessionId: "child-b" }], failed: 1, failures: [{ index: 1, error: "startup failure" }] });
const receipt = (await started).structuredContent;
assert.equal(receipt.sessions[0].taskIndex, 1);
assert.equal(receipt.failures[0].taskIndex, 0);
assert.equal(launches, 1);
assert.equal((await tools[0].execute("retry-startup", { taskIndexes: [0] })).structuredContent.sessions[0].taskIndex, 0);
await assert.rejects(tools[0].execute("rerun-started", { taskIndexes: [1] }), /already dispatched/);
assert.equal(launches, 2);
await assert.rejects(tools[1].execute("foreign-wait", { sessionIds: ["unrelated"] }), /not launched/);
await assert.rejects(tools[2].execute("foreign-get", { sessionId: "unrelated" }), /not launched/);
let retries = 0;
const retrying = createCoordinatorTools(plan, process.cwd(), {
  startBatch: async () => { if (++retries === 1) throw new Error("no capacity"); return { requested: 1, started: 1, sessionIds: ["retry"], sessions: [{ index: 0, sessionId: "retry" }] }; },
});
await assert.rejects(retrying[0].execute("rejected", {}), /no capacity/);
assert.equal((await retrying[0].execute("retry", {})).structuredContent.started, 1);
console.log("  OK -> concurrent duplicate dispatch, partial startup receipts, own-ID isolation and admission retry");
