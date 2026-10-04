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

// Tool loops get one finalization steer at 75%, then an abort at the hard turn budget.
{
  const w = worker(4, 60_000);
  let resolvePrompt;
  const promptDone = new Promise((resolve) => { resolvePrompt = resolve; });
  const session = {
    aborts: 0,
    steers: [],
    prompt: async () => promptDone,
    waitForIdle: async () => {},
    steer: async (text) => { session.steers.push(text); },
    abort: async () => { session.aborts++; resolvePrompt(); },
  };
  w.session = session;
  w.track(session, "inspect");
  for (let i = 0; i < 3; i++) {
    w.onEvent({ type: "turn_start" });
    w.onEvent({ type: "turn_end", toolResults: [{}] });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.steers.length, 1);
  w.onEvent({ type: "turn_start" });
  w.onEvent({ type: "turn_end", toolResults: [{}] });
  await w.run;
  assert.equal(session.aborts, 1);
  assert.equal(w.state, "aborted");
  assert.equal(w.termination.reason, "max_turns");
  assert.equal(w.termination.limit, 4);
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
