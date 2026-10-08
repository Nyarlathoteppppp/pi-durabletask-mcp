import assert from "node:assert/strict";
import { PiWorker } from "../dist/pi/worker.js";
import { assertThinkingSupported } from "../dist/pi/models.js";
import { bindCancellation } from "../dist/tools/spawn.js";
import { waitForProgress } from "../dist/tools/control.js";

function worker(maxTurns, maxDurationMs) {
  return new PiWorker({
    cwd: "/tmp",
    tools: ["read"],
    maxTurns,
    maxDurationMs,
  });
}

// Unsupported thinking must fail before a paid session is started.
assert.throws(
  () => assertThinkingSupported(
    { provider: "test", id: "plain", reasoning: false, thinkingLevelMap: undefined },
    "high",
  ),
  /does not support thinking: high/,
);
assert.doesNotThrow(() => assertThinkingSupported(
  { provider: "test", id: "reasoner", reasoning: true, thinkingLevelMap: { low: "low", high: null } },
  "low",
));
assert.throws(
  () => assertThinkingSupported(
    { provider: "test", id: "reasoner", reasoning: true, thinkingLevelMap: { low: "low", high: null } },
    "high",
  ),
  /does not support thinking: high/,
);
// Pi's rules: a map entry of null refuses a level (even off); off..high need no entry; xhigh and
// max need one. The error lists what the model accepts.
{
  const { supportedThinkingLevels } = await import("../dist/pi/models.js");
  const partial = { provider: "test", id: "partial", reasoning: true, thinkingLevelMap: { low: "low", off: null } };
  assert.deepEqual(supportedThinkingLevels(partial), ["minimal", "low", "medium", "high"]);
  assert.doesNotThrow(() => assertThinkingSupported(partial, "high"), "an absent entry up to high is supported");
  assert.throws(() => assertThinkingSupported(partial, "off"), /supports: minimal, low, medium, high/);
  const unmapped = { provider: "test", id: "unmapped", reasoning: true, thinkingLevelMap: undefined };
  assert.throws(() => assertThinkingSupported(unmapped, "xhigh"), /does not support thinking: xhigh.*supports: off, minimal, low, medium, high/);
  assert.deepEqual(supportedThinkingLevels({ ...unmapped, thinkingLevelMap: { xhigh: "xhigh" } }),
    ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(supportedThinkingLevels({ provider: "test", id: "plain", reasoning: false }), ["off"]);
}

// MCP caller cancellation must reach the worker exactly once.
const controller = new AbortController();
let cancellations = 0;
const unbind = bindCancellation(controller.signal, async () => { cancellations++; });
controller.abort();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(cancellations, 1);
unbind();

// Waiting observes progress but does not own or abort the background worker.
{
  const waiting = {
    state: "running",
    turns: 0,
    toolCalls: [],
    questions: new Map(),
    snapshot() { return { state: this.state, turns: this.turns, toolCalls: this.toolCalls }; },
  };
  const pending = waitForProgress(waiting, 500, undefined, 0, 0);
  setTimeout(() => { waiting.turns = 1; }, 20);
  assert.equal((await pending).turns, 1);
  assert.equal(waiting.state, "running");
}

// An interaction is progress even after the current turn/tool has already been observed.
{
  const w = worker(5, 60_000);
  w.state = "running";
  const waiting = waitForProgress(w, 1500);
  setTimeout(() => w.questions.set("confirm", { toJSON: () => ({ id: "confirm", kind: "confirm" }) }), 20);
  // A 1.5s timeout must not delay a question which the existing 200ms poll can observe.
  let timer;
  let result;
  try {
    result = await Promise.race([waiting,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("wait did not wake for a question")), 800); }),
    ]);
  } finally { clearTimeout(timer); }
  assert.equal(result.questions[0].id, "confirm");
  assert.equal(w.state, "running");
  assert.equal(w.questions.size, 1);
  let delivered = false;
  const immediate = waitForProgress(w, 1500).then(snapshot => { delivered = true; return snapshot; });
  await Promise.resolve();
  assert.equal(delivered, true, "an existing question returns without waiting for a poll or timeout");
  assert.equal((await immediate).questions[0].id, "confirm");
}

// Tool loops get one finalization steer at 75%, lose their tools for the last turn, and are
// aborted only if a tool call still reaches the hard turn budget.
{
  const w = worker(8, 60_000);
  let resolvePrompt;
  const promptDone = new Promise((resolve) => { resolvePrompt = resolve; });
  const session = {
    aborts: 0,
    steers: [],
    tools: ["read"],
    prompt: async () => promptDone,
    waitForIdle: async () => {},
    steer: async (text) => { session.steers.push(text); },
    abort: async () => { session.aborts++; resolvePrompt(); },
    getActiveToolNames: () => session.tools,
    setActiveToolsByName: (names) => { session.tools = names; },
  };
  w.session = session;
  w.track(session, "inspect");
  const turn = () => { w.onEvent({ type: "turn_start" }); w.onEvent({ type: "turn_end", toolResults: [{}] }); };
  for (let i = 0; i < 6; i++) turn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.steers.length, 1, "75% steer");
  assert.deepEqual(session.tools, ["read"]);
  turn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(session.tools, [], "no tools for the last turn");
  assert.match(session.steers[1], /last turn/);
  turn();
  await w.run;
  assert.equal(session.aborts, 1);
  assert.equal(w.state, "aborted");
  assert.equal(w.termination.reason, "max_turns");
  assert.equal(w.termination.limit, 8);
}

// A slow tool loop gets the same finalization steer at 75% of its time, once, before the deadline.
// A delegate whose last turn used no tools is writing its answer and is left alone.
{
  const fixture = (toolResults) => {
    const w = worker(40, 400);
    let resolvePrompt;
    const promptDone = new Promise((resolve) => { resolvePrompt = resolve; });
    const session = {
      steers: [],
      prompt: async () => promptDone,
      waitForIdle: async () => {},
      steer: async (text) => { session.steers.push(text); },
      abort: async () => { resolvePrompt(); },
    };
    w.session = session;
    w.track(session, "inspect");
    w.onEvent({ type: "turn_start" });
    w.onEvent({ type: "turn_end", toolResults });
    return { w, session };
  };
  const looping = fixture([{}]);
  const writing = fixture([{}]);
  await new Promise((resolve) => setTimeout(resolve, 340));
  // The turn under way when time runs short may be the answer itself; steer only after it calls tools.
  assert.equal(looping.session.steers.length, 0, "not mid-turn");
  looping.w.onEvent({ type: "turn_start" });
  looping.w.onEvent({ type: "turn_end", toolResults: [{}] });
  writing.w.onEvent({ type: "turn_start" });
  writing.w.onEvent({ type: "turn_end", toolResults: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(looping.session.steers.length, 1, "steered once by time");
  assert.match(looping.session.steers[0], /final answer/);
  assert.equal(writing.session.steers.length, 0, "an answer is not followed by a steer");
  for (let i = 0; i < 30; i++) {
    looping.w.onEvent({ type: "turn_start" });
    looping.w.onEvent({ type: "turn_end", toolResults: [{}] });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(looping.session.steers.length, 1, "the turn budget does not steer a second time");
  await Promise.all([looping.w.run, writing.w.run]);
  assert.equal(looping.w.termination.reason, "deadline");
}

// A running delegate reports how long it has been silent and what it waits on: "model" only while a
// model request is outstanding (turn_start to the assistant's message_end), "tool" while a tool runs,
// "agent" while Pi or an extension works in between. Nothing while a question awaits the caller.
{
  const w = worker(10, 60_000);
  let resolvePrompt;
  const promptDone = new Promise((resolve) => { resolvePrompt = resolve; });
  const session = { prompt: async () => promptDone, waitForIdle: async () => {}, steer: async () => {}, abort: async () => {} };
  w.session = session;
  w.track(session, "inspect");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  assert.equal(w.snapshot().phase, "agent", "before the first model request");
  w.onEvent({ type: "turn_start" });
  assert.equal(w.snapshot().phase, "model");
  await pause(120);
  assert.ok(w.snapshot().idleMs >= 100, "silence counts up");
  w.onEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" }, message: { role: "assistant", content: [] } });
  assert.ok(w.snapshot().idleMs < 100, "any stream event is activity");
  w.onEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "toolUse" } });
  assert.equal(w.snapshot().phase, "agent", "the model has answered");
  w.onEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
  assert.equal(w.snapshot().phase, "tool");
  w.onEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "", isError: false });
  // A call recorded as running but not executing in this process (left over from a recovered run) is not a tool phase.
  w.toolCalls.push({ seq: 99, name: "read", state: "running" });
  assert.equal(w.snapshot().phase, "agent");
  // A provider retry waits its backoff before requesting again; that wait is not silence.
  w.onEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: "overloaded" });
  assert.equal(w.snapshot().phase, "model");
  await pause(150);
  assert.equal(w.snapshot().idleMs, 0, "backoff is not counted");
  w.questions.set("q", { toJSON: () => ({ id: "q" }) });
  assert.deepEqual([w.snapshot().idleMs, w.snapshot().phase], [undefined, undefined], "waiting on the caller, not the model");
  w.questions.clear();
  resolvePrompt();
  await w.run;
  const finished = w.snapshot();
  assert.deepEqual([finished.idleMs, finished.phase], [undefined, undefined], "only running delegates report it");
}

// maxToolCalls counts the model's own calls: calls nested in a codemode script or MCP tool do not count.
{
  const w = new PiWorker({ cwd: "/tmp", tools: ["read"], maxTurns: 50, maxDurationMs: 60_000, maxToolCalls: 2 });
  const session = { tools: ["read"], steers: [], prompt: () => new Promise(() => {}), waitForIdle: async () => {},
    steer: async (text) => { session.steers.push(text); }, abort: async () => {},
    getActiveToolNames: () => session.tools, setActiveToolsByName: (names) => { session.tools = names; } };
  w.session = session;
  w.track(session, "inspect");
  w.onEvent({ type: "turn_start" });
  w.onEvent({ type: "tool_execution_start", toolCallId: "script", toolName: "codemode", args: {} });
  for (const id of ["n1", "n2", "n3"]) w.onEvent({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: {}, parentToolCallId: "script" });
  w.onEvent({ type: "turn_end", toolResults: [{}] });
  assert.deepEqual(session.tools, ["read"], "one own call so far, though four were recorded");
  w.onEvent({ type: "turn_start" });
  w.onEvent({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: {} });
  w.onEvent({ type: "turn_end", toolResults: [{}] });
  assert.deepEqual(session.tools, [], "two own calls: the cap");
  assert.match(w.notices.at(-1).message, /tool-call cap 2\/2 \(turn 2\/50\)/);
  w.dispose();
}

// Wall-clock expiry aborts the underlying session and records a diagnostic reason.
{
  const w = worker(50, 20);
  let resolvePrompt;
  const promptDone = new Promise((resolve) => { resolvePrompt = resolve; });
  const session = {
    prompt: async () => promptDone,
    waitForIdle: async () => {},
    steer: async () => {},
    abort: async () => { resolvePrompt(); },
  };
  w.session = session;
  w.track(session, "inspect");
  await w.run;
  assert.equal(w.state, "aborted");
  assert.equal(w.termination.reason, "deadline");
}

console.log("  OK -> thinking validation, cancellation, non-destructive wait, turn/time circuit breakers");
