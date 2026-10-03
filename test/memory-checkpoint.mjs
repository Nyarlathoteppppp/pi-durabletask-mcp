import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "pi-memory-checkpoint-"));
const agent = join(dir, "agent");
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agent,
  PI_DELEGATE_STATE_DIR: join(dir, "state"), PI_DELEGATE_IGNORE_SCOPE: "1" });
let requestCount = 0;
const http = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requestCount++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "memory-test", object: "chat.completion.chunk", created: 1, model: "one",
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  if (request.messages.at(-1).role !== "tool") {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: `read-${requestCount}`, type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: join(dir, "public.txt") }) } }] });
    emit({}, "tool_calls");
  } else { emit({ role: "assistant", content: "OK" }); emit({}, "stop"); }
  res.end("data: [DONE]\n\n");
});
await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
let worker;
try {
  await mkdir(agent);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off" }));
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: "fake",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000,
      maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(join(dir, "public.txt"), "PUBLIC_RESULT\n");
  const { PiWorker } = await import("../dist/pi/worker.js");
  worker = new PiWorker({ cwd: dir, model: "test/one", durable: false, tools: ["read"], maxTurns: 8, maxDurationMs: 60000 });
  let checkpoints = 0;
  const checkpoint = worker.checkpoint.bind(worker);
  worker.checkpoint = () => { checkpoints++; return checkpoint(); };
  await worker.start("Read public.txt, then say OK");
  await worker.run;
  assert.equal(worker.state, "done");
  assert.equal(worker.lastText, "OK");
  assert.equal(worker.turns, 2);
  assert.equal(worker.toolCalls[0].state, "ok");
  assert.match(worker.toolCalls[0].result, /PUBLIC_RESULT/);
  // Only the run's input/result need checkpoints; events must not build discarded history.
  assert.ok(checkpoints <= 2, `memory run constructed ${checkpoints} checkpoints`);
  checkpoints = 0;
  await worker.followUp("Read public.txt again, then say OK");
  await worker.run;
  assert.equal(worker.state, "done");
  assert.equal(worker.turns, 4);
  assert.equal(worker.toolCalls.length, 2);
  assert.ok(checkpoints <= 2, `memory follow-up constructed ${checkpoints} checkpoints`);

  // SDK nested calls use extension hooks rather than the agent subscriber.
  for (const durable of [false, true]) {
    const nested = new PiWorker({ cwd: dir, durable, tools: [], maxTurns: 8, maxDurationMs: 60000 });
    let saves = 0;
    nested.job = { save: async () => { saves++; } };
    nested.checkpoint = () => { assert.ok(durable, "memory nested call must not construct a checkpoint"); return {}; };
    const hooks = new Map();
    nested.nativeExecutionJournal().factory({ on: (name, handler) => hooks.set(name, handler) });
    const event = { toolCallId: "nested", parentToolCallId: "parent", toolName: "mcp__fixture__echo", args: {} };
    hooks.get("tool_execution_start")({ ...event, type: "tool_execution_start" });
    assert.equal(await hooks.get("tool_call")(event), undefined);
    await hooks.get("tool_execution_end")({ ...event, type: "tool_execution_end", result: { content: [{ type: "text", text: "NESTED_OK" }] }, isError: false });
    assert.equal(nested.toolCalls[0].state, "ok");
    assert.equal(nested.toolCalls[0].parentToolCallId, "parent");
    assert.equal(saves, durable ? 2 : 0, "durable nested calls keep both persistence barriers");
  }
  console.log("  OK -> memory SDK runs/follow-up/nested calls skip event checkpoints; durable barriers remain");
} finally {
  worker?.dispose();
  http.closeAllConnections();
  await new Promise(resolve => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
