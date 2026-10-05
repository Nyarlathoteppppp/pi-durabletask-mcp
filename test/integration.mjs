import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = await mkdtemp(join(tmpdir(), "pi-delegate-integration-"));
const requests = [];
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: request.model,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  const lastUser = request.messages.findLast((m) => m.role === "user");
  if (JSON.stringify(lastUser?.content).includes("GREP_FIXTURE") && request.messages.at(-1).role !== "tool") {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: "call_test_grep", type: "function",
      function: { name: "grep", arguments: JSON.stringify({ pattern: "TEST_MARKER", glob: "*", path: dir }) } }] });
    emit({}, "tool_calls");
  } else {
    emit({ role: "assistant", content: request.messages.at(-1).role === "tool" ? "SEARCH_OK" : "OK" });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "offline-integration", version: "1" });
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off", enabledModels: ["test/*"],
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: ["one", "two"].map((id) => ({ id, name: id, reasoning: false, input: ["text"],
      contextWindow: 16000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  await writeFile(join(dir, "public.txt"), "TEST_MARKER public\n");
  await writeFile(join(dir, ".env"), "TEST_MARKER FAKE_SECRET_DO_NOT_RETURN\n");
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"],
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir,
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_MODEL_ALLOWLIST: "test/one,test/two", PI_DELEGATE_IGNORE_SCOPE: "1" } }));
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await call("sessions")).count, 0, "sessions works before init");
  const direct = await call("run", { cwd: dir, prompt: "Reply OK", tools: [] });
  assert.equal(direct.state, "done", "real SDK execution works before init");
  await call("forget", { sessionId: direct.sessionId });
  requests.length = 0;
  assert.equal((await call("init", { cwd: dir, models: "test/" })).models.defaultWhenYouOmitModel, "test/one");

  const invalidBatch = await raw("spawn_batch", { cwd: dir, tasks: [
    { prompt: "OK", tools: [] }, { prompt: "OK", tools: [], thinking: "high" },
  ] });
  assert.equal(invalidBatch.isError, true);
  assert.match(invalidBatch.content[0].text, /does not support thinking/);
  assert.equal(requests.length, 0, "invalid batch must not contact a provider");
  assert.equal((await call("sessions")).count, 0);

  const first = await call("run", { cwd: dir, id: "default", prompt: "Reply OK", tools: [], maxTurns: 5, verbose: true });
  assert.equal(first.model, "test/one");
  assert.equal(first.lastText, "OK");
  assert.equal(first.state, "done");
  assert.deepEqual(first.activeTools, []);
  assert.equal(requests[0].tools?.length ?? 0, 0);

  const override = await call("run", { cwd: dir, prompt: "Reply OK", model: "test/two", tools: [], verbose: true });
  assert.equal(override.model, "test/two");
  assert.equal(requests[1].model, "two");
  assert.equal((await raw("run", { cwd: dir, prompt: "blocked", tools: ["bash"] })).isError, true);

  const search = await call("run", { cwd: dir, prompt: "GREP_FIXTURE: search once, then conclude.", tools: ["grep"], maxTurns: 5, verbose: true });
  assert.equal(search.state, "done");
  assert.equal(search.lastText, "SEARCH_OK");
  assert.equal(search.toolCalls.length, 1);
  const toolResult = requests.findLast((r) => r.messages.some((m) => m.role === "tool"))
    .messages.find((m) => m.role === "tool").content;
  assert.match(JSON.stringify(toolResult), /TEST_MARKER public/);
  assert.doesNotMatch(JSON.stringify(toolResult), /FAKE_SECRET_DO_NOT_RETURN/);

  await call("follow_up", { sessionId: "default", prompt: "Reply OK again" });
  let followup;
  do { followup = await call("wait", { sessionId: "default", timeoutMs: 1000 }); }
  while (followup.state === "running");
  assert.equal(followup.state, "done");
  assert.equal(followup.lastText, "OK");
  assert.ok(requests.at(-1).messages.filter((m) => m.role === "user").length >= 2);
  // Attachments outside the delegate's cwd reach the model, on run, follow_up and each batch task.
  const outside = await mkdtemp(join(tmpdir(), "pi-delegate-attach-"));
  const lastUserText = () => JSON.stringify(requests.at(-1).messages.findLast((m) => m.role === "user").content);
  try {
    await writeFile(join(outside, "a.diff"), "+ATTACHED_DIFF_LINE\n");
    await writeFile(join(outside, "b.txt"), "SECOND_ATTACHMENT\n");
    await call("run", { cwd: dir, prompt: "Reply OK", tools: [], attachments: [join(outside, "a.diff")] });
    assert.match(lastUserText(), /ATTACHED_DIFF_LINE/);
    await call("follow_up", { sessionId: "default", prompt: "Reply OK", attachments: [join(outside, "b.txt")] });
    do followup = await call("wait", { sessionId: "default", timeoutMs: 1000 }); while (followup.state === "running");
    assert.match(lastUserText(), /SECOND_ATTACHMENT/);
    requests.length = 0;
    const batch = await call("spawn_batch", { cwd: dir, tools: [], attachments: [join(outside, "a.diff")], tasks: [
      { prompt: "Reply OK" }, { prompt: "Reply OK", attachments: [] }] });
    await call("wait", { sessionIds: batch.sessions.map((s) => s.sessionId), until: "all_settled", timeoutMs: 15000 });
    const seen = requests.map((r) => JSON.stringify(r.messages)).map((m) => m.includes("ATTACHED_DIFF_LINE"));
    assert.deepEqual(seen.sort(), [false, true], "the batch attachment goes to the task that does not clear it");
    const bad = await raw("spawn_batch", { cwd: dir, tools: [], tasks: [{ prompt: "OK" }, { prompt: "OK", attachments: [join(dir, ".env")] }] });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /tasks\[1\].*secret/);
  } finally { await rm(outside, { recursive: true, force: true }); }

  await call("forget", { sessionId: "default" });
  assert.equal((await raw("status", { sessionId: "default" })).isError, true);
  console.log("  OK -> real MCP + Pi SDK against local fake provider: defaults, overrides, no-tools, safe grep, follow-up, batch validation");
} finally {
  await client.close();
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
