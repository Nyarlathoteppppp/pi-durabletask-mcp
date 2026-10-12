import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The caller's context pays for every tool result, on every poll: results carry what the caller can act
// on and leave out what it already has or cannot use.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-compact-"));
const report = `No findings.\n\nChecked   the recovery paths,\tthe wait semantics and ${"the tests ".repeat(200)}`;
let slowRequests = 0;
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const prompt = JSON.stringify(request.messages.find((m) => m.role === "user")?.content);
  // SLOW fails once (a retry notice), then answers after a pause long enough to wait on.
  if (prompt.includes("SLOW") && ++slowRequests === 1) {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end('{"error":{"message":"overloaded"}}');
  }
  if (prompt.includes("SLOW")) await new Promise((resolve) => setTimeout(resolve, 2500));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk",
    created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  emit({ role: "assistant", content: prompt.includes("LONG") ? report : "Done." });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "compact-results", version: "1" });
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"],
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 20 } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0" } }));
  const rawText = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return result.content[0].text;
  };
  const call = async (name, args) => JSON.parse(await rawText(name, args));

  // 1. Results are compact JSON, not indented for a human reader.
  const spawned = await rawText("spawn", { cwd: dir, id: "slow", prompt: "SLOW", tools: [] });
  assert.ok(!spawned.includes("\n"), "no pretty-printing");

  // 2. A running session in a wait carries no fixed follow-up fields, and only notices that arose
  //    during this wait: the retry before it was already news.
  let status;
  do status = await call("status", { sessionId: "slow" });
  while (!status.notices.some((n) => /provider retry/.test(n.message)));
  const single = await call("wait", { sessionId: "slow", until: "settled", timeoutMs: 300 });
  assert.equal(single.state, "running");
  for (const key of ["canFollowUp", "followUpBlockedReason"]) assert.ok(!(key in single), key);
  assert.deepEqual(single.notices, []);
  const batchRunning = (await call("wait", { sessionIds: ["slow"], until: "all_settled", timeoutMs: 300 })).sessions[0];
  assert.equal(batchRunning.state, "running");
  for (const key of ["canFollowUp", "followUpBlockedReason", "pendingQuestions", "notices"]) assert.ok(!(key in batchRunning), key);
  let finished;
  do finished = await call("wait", { sessionId: "slow", until: "settled", timeoutMs: 5000 });
  while (finished.state === "running");
  assert.equal(finished.state, "done");
  assert.ok(finished.notices.some((n) => /provider retry/.test(n.message)), "the finished result keeps the run's notices");
  assert.equal(finished.canFollowUp, true);

  // 3. A long saved text is not repeated, but its start is: enough to read "No findings" without the file.
  const preview = "No findings. Checked the recovery paths, the wait semantics and the tests the tests the tests the tests the tests the tests the tests the tests the tests the…";
  const saved = await call("run", { cwd: dir, prompt: "LONG", tools: [], saveTo: join(dir, "out", "report.md") });
  assert.equal(saved.lastText, undefined);
  assert.equal(saved.preview, preview);
  const batch = await call("spawn_batch", { cwd: dir, tools: [], saveDir: join(dir, "out"), tasks: [{ prompt: "LONG" }] });
  const summary = (await call("wait", { sessionIds: batch.sessionIds, until: "all_settled", timeoutMs: 15000 })).sessions[0];
  assert.equal(summary.state, "done");
  assert.equal(summary.preview, preview);
  assert.ok(!("pendingQuestions" in summary), "no zero question count");
  // 4. Tool definitions are loaded into the caller's context too: the coordinator plan is defined once,
  //    on spawn; run and spawn_batch refer to it and still check it the same way.
  const { tools } = await client.listTools();
  const schemaOf = (name) => tools.find((t) => t.name === name).inputSchema;
  assert.ok(schemaOf("spawn").properties.coordinator.properties, "spawn defines the plan");
  for (const [name, schema] of [["run", schemaOf("run")], ["spawn_batch", schemaOf("spawn_batch")],
    ["spawn_batch task", schemaOf("spawn_batch").properties.tasks.items]])
    assert.equal(schema.properties.coordinator.properties, undefined, `${name} refers to it`);
  for (const [name, args] of [["run", { cwd: dir, coordinator: { tasks: [{}] } }],
    ["spawn_batch", { cwd: dir, tasks: [{ coordinator: { tasks: [{}] } }] }]]) {
    const refused = await client.callTool({ name, arguments: args });
    assert.equal(refused.isError, true, `${name} still checks the plan`);
    assert.match(refused.content[0].text, /prompt/);
  }
  console.log("  OK -> compact JSON; running waits drop fixed fields and earlier notices; saved texts keep a preview; the coordinator plan is defined once");
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
