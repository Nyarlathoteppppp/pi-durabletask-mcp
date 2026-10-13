import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The fake model replies with the first user message, so each result shows the prompt it ran.
const dir = await mkdtemp(join(tmpdir(), "pi-coordinator-question-"));
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const user = request.messages.find((m) => m.role === "user");
  const text = typeof user.content === "string" ? user.content : user.content.map((p) => p.text ?? "").join("");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "echo", object: "chat.completion.chunk", created: 1, model: request.model,
    choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  emit({ role: "assistant", content: text });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: ["one", "two"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }));
  Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
    PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0", PI_DELEGATE_ALLOW_TOOLS: "codemode" });
  const { coordinatorSchema, createCoordinatorTools } = await import("../dist/coordinator.js");
  const core = await import("../dist/core.js");

  // One question for several models: members name only their model, and a member's own prompt follows the shared one.
  const plan = coordinatorSchema.parse({ prompt: "SHARED-QUESTION",
    tasks: [{ label: "first", model: "test/one" }, { label: "second", model: "test/two", prompt: "OWN-PART" }] });
  const tools = createCoordinatorTools(plan, dir, core);
  const start = tools.find((t) => t.name === "delegate_start_batch");
  assert.equal(start.description.split("SHARED-QUESTION").length, 2, "the shared question is listed once");
  const { sessionIds } = (await start.execute("start", {})).structuredContent;
  const done = await core.waitForMany(sessionIds, { until: "all_settled", timeoutMs: 15000 });
  assert.deepEqual(done.pending, []);
  const texts = Object.fromEntries(await Promise.all(sessionIds.map(async (id) => {
    const s = await core.getState(id);
    return [s.model, s.lastText];
  })));
  assert.deepEqual(texts, { "test/one": "SHARED-QUESTION", "test/two": "SHARED-QUESTION\n\nOWN-PART" });

  // Without a shared question every member still needs its own prompt; the plan is refused before anything starts.
  const missing = coordinatorSchema.safeParse({ tasks: [{ model: "test/one" }, { prompt: "x" }] });
  assert.equal(missing.success, false);
  assert.match(JSON.stringify(missing.error.issues), /prompt/);

  // The default synthesis compares the independent answers when the plan shares a question.
  const coordinator = await core.startExecution({ cwd: dir, coordinator: { prompt: "SHARED-QUESTION", tasks: [{ model: "test/one" }] } });
  await core.waitForMany([coordinator.sessionId], { until: "all_settled", timeoutMs: 15000 });
  assert.match((await core.getState(coordinator.sessionId)).lastText, /same question/);
  console.log("  OK -> a coordinator plan can send one question to several models, each member's own part added after it; the default synthesis compares their answers");
} finally {
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
process.exit(0);
