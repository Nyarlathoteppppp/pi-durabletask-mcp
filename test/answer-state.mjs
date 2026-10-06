import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// answerState flags a finished run whose final text is not a usable conclusion: "missing" (no text)
// and "partial" (cut off by the output limit) by rule; "narration" only when the optional Jev judge
// is enabled and confident. Nothing is reported for a conclusion, or when the judge fails.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-answer-state-"));
let jevDown = false;
const jevCalls = [];
const servers = [];
const listen = async (handler) => {
  const server = createServer(async (req, res) => { let body = ""; for await (const c of req) body += c; handler(JSON.parse(body), res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server.address().port;
};
const provider = await listen((request, res) => {
  const last = JSON.stringify(request.messages.at(-1));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "a", object: "chat.completion.chunk", created: 1,
    model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (last.includes("NARRATE")) emit({ role: "assistant", content: "Let me look at the remaining files next." });
  else if (last.includes("SILENT")) emit({ role: "assistant", content: "" });
  else emit({ role: "assistant", content: last.includes("CUT") ? "The three issues are: first, the" : "Found two bugs: a race and a leak." });
  emit({}, last.includes("CUT") ? "length" : "stop");
  res.end("data: [DONE]\n\n");
});
const jev = await listen(async (request, res) => {
  jevCalls.push(request);
  if (jevDown) { res.writeHead(500); return res.end("down"); }
  if (request.state.TASK.includes("SLOWJEV")) await new Promise((resolve) => setTimeout(resolve, 1200));
  const narration = request.state.FINAL_TEXT.startsWith("Let me");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ answers: { q: { choice: narration ? "narration" : "complete",
    probabilities: narration ? { narration: 0.97, complete: 0.03 } : { complete: 0.99, narration: 0.01 }, confidence: 0.9 } } }));
});
const client = new Client({ name: "answer-state", version: "1" });
let serverEnv;
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${provider}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  serverEnv = { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
    PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_JUDGE: "jev",
    PI_DELEGATE_JUDGE_URL: `http://127.0.0.1:${jev}/v1/systemone`, TYPESAFE_API_KEY: "test-key" };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore", env: serverEnv }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const finish = async (id, prompt, extra = {}) => {
    await call("spawn", { cwd: dir, id, prompt, tools: [], ...extra });
    let snap;
    do snap = await call("wait", { sessionId: id, until: "settled", timeoutMs: 10000 }); while (snap.nextAction === "wait");
    return call("status", { sessionId: id });
  };

  const narration = await finish("narrate", "Review the code. NARRATE");
  assert.equal(narration.state, "done");
  assert.equal(narration.answerState, "narration");
  assert.equal(jevCalls.at(-1).state.TASK, "Review the code. NARRATE", "Jev sees the task and the final text");
  assert.equal((await finish("answer", "Review the code.")).answerState, undefined, "a conclusion is not flagged");
  assert.equal((await finish("cut", "Review the code. CUT")).answerState, "partial", "output limit, by rule");
  assert.equal((await finish("silent", "Review the code. SILENT")).answerState, "missing", "no text, by rule");
  // The run's deadline does not cover the judge: the model already finished in time.
  const late = await finish("late", "Review the code. NARRATE SLOWJEV", { maxDurationMs: 1000 });
  assert.deepEqual([late.state, late.answerState], ["done", "narration"], JSON.stringify(late.termination));
  // A durable result keeps its flag when another process loads it (here via a refused follow_up).
  await finish("kept", "Review the code. CUT", { durable: true, maxTurns: 1 });
  await client.close();
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore", env: serverEnv }));
  const refused = await client.callTool({ name: "follow_up", arguments: { sessionId: "kept", prompt: "more" } });
  assert.equal(refused.isError, true);
  assert.equal((await call("status", { sessionId: "kept" })).answerState, "partial");
  const calls = jevCalls.length;
  jevDown = true;
  assert.equal((await finish("down", "Review the code. NARRATE")).answerState, undefined, "judge failure means unknown");
  assert.equal(jevCalls.length, calls + 1);
  console.log("  OK -> answerState: missing and partial by rule, narration from a confident judge, nothing for a conclusion or a failed judge");
} finally {
  await client.close().catch(() => {});
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
