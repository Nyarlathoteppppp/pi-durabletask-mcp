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
await assert.rejects(startExecution({ cwd: process.cwd(), coordinator: { tasks: [{ prompt: "child" }] } }), /codemode.*blocked/);
await assert.rejects(startExecution({ cwd: process.cwd() }), /prompt is required/);
for (const task of [{ prompt: "x", maxTurns: 6 }, { prompt: "x", maxDurationMs: 60001 }, { prompt: "x", tools: ["write"] }, { prompt: "x", coordinator: { tasks: [] } }]) {
  assert.equal(coordinatorSchema.safeParse({ tasks: [task] }).success, false);
}
console.log("  OK -> coordinator direct-core policy and defaults respect configured budget ceilings");

// Use controllable startup to cover a duplicate dispatch while its first call is pending.
const { createCoordinatorTools } = await import("../dist/coordinator.js");
const starting = Promise.withResolvers();
let launches = 0;
const followRequests = [];
const tools = createCoordinatorTools(coordinatorSchema.parse({ tasks: [{ prompt: "a" }, { prompt: "b" }] }), process.cwd(), {
  startBatch: async () => { if (++launches === 1) return starting.promise; return { requested: 1, started: 1, sessionIds: ["child-a"], sessions: [{ index: 0, sessionId: "child-a" }] }; },
  waitForMany: async () => ({ settled: [], pending: [], continueIds: [], sessions: [] }),
  getState: async (sessionId) => ({ sessionId, state: "done", lastText: "report", questions: [], remainingTurns: 0, canFollowUp: false, followUpBlockedReason: "turn_budget_exhausted" }),
  followUp: async (...args) => { followRequests.push(args); return {sessionId:args[0],state:"running"}; },
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
const follow = tools.find((t) => t.name === "delegate_follow_up");
await assert.rejects(follow.execute("foreign-follow", { sessionId: "unrelated", prompt: "continue" }), /not launched/);
for (const extra of [{maxTurns:6}, {maxToolCalls:1001}, {tools:["write"]}, {model:"other"}, {saveTo:"/tmp/overwrite.md"}]) {
  await assert.rejects(follow.execute("invalid", {sessionId:"child-a",prompt:"continue",...extra}));
}
assert.equal(followRequests.length,0, "foreign IDs and invalid budgets/grants never reach the core");
const aborted = AbortSignal.abort();
await assert.rejects(follow.execute("cancelled", {sessionId:"child-a",prompt:"continue"},aborted), /abort/i);
assert.equal(followRequests.length,0);
const childState = (await tools[2].execute("own-get", {sessionId:"child-a"})).structuredContent;
assert.equal(childState.nextAction,"finish");
assert.equal(childState.remainingTurns,0);
assert.equal(childState.followUpBlockedReason,"turn_budget_exhausted");
assert.equal((await tools[1].execute("own-wait",{sessionIds:["child-a"]})).structuredContent.nextAction,"finish");
assert.equal((await follow.execute("own-follow", {sessionId:"child-a",prompt:"verify one claim",maxTurns:3})).structuredContent.nextAction,"wait");
assert.deepEqual(followRequests[0],["child-a","verify one claim",undefined,undefined,{maxTurns:3,maxToolCalls:undefined}]);
let retries = 0;
const retrying = createCoordinatorTools(plan, process.cwd(), {
  startBatch: async () => { if (++retries === 1) throw new Error("no capacity"); return { requested: 1, started: 1, sessionIds: ["retry"], sessions: [{ index: 0, sessionId: "retry" }] }; },
});
await assert.rejects(retrying[0].execute("rejected", {}), /no capacity/);
assert.equal((await retrying[0].execute("retry", {})).structuredContent.started, 1);
console.log("  OK -> concurrent duplicate dispatch, partial startup receipts, own-ID isolation and admission retry");

let researchRequest;
const researching = createCoordinatorTools(coordinatorSchema.parse({ research: true, tasks: [{prompt:"web",tools:[]},{prompt:"off",research:false}] }), process.cwd(), {
  startBatch: async (request) => { researchRequest = request; return {requested:2,started:0,sessionIds:[],sessions:[]}; },
});
await researching[0].execute("research",{});
assert.deepEqual(researchRequest.tasks[0].tools,["mcp__exa__web_search_exa","mcp__exa__web_fetch_exa"]);
assert.deepEqual(researchRequest.tasks[0].mcpServers,["exa"]);
assert.equal(researchRequest.tasks[0].nativeMcp,true);
assert.equal("research" in researchRequest.tasks[0],false);
assert.deepEqual(researchRequest.tasks[1].tools,["read","grep","find","ls"]);
assert.deepEqual(researchRequest.tasks[1].mcpServers,[]);
assert.equal(researchRequest.tasks[1].nativeMcp,false);
const {startBatch} = await import("../dist/core.js");
await assert.rejects(startBatch(researchRequest), /are blocked/);
console.log("  OK -> research inheritance/opt-out, exact grants and existing permission checks");
