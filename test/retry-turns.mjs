import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Pi's automatic retries of a failed provider request are not turns: a run that needed two
// retries before its one answer has used one turn of its budget.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-retry-turns-"));
let requests = 0;
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  if (++requests === 1) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end('{"error":{"message":"overloaded"}}'); }
  // A gateway's verbose error body, as Cloudflare sends: the notice keeps its title, not the whole body.
  if (requests === 2) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({
    type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/",
    title: "Error 524: A timeout occurred", detail: "The origin web server did not return a complete response. ".repeat(8),
    ray_id: "a483c0e98d01e6d1", what_you_should_do: "Wait and retry. ".repeat(10) })); }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk",
    created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  emit({ role: "assistant", content: "OK" });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "retry-turns", version: "1" });
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"],
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 20 } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1" } }));
  const result = await client.callTool({ name: "run", arguments: { cwd: dir, prompt: "hello", tools: [], maxTurns: 5, verbose: true } });
  const snap = JSON.parse(result.content[0].text);
  assert.equal(snap.state, "done", snap.error);
  assert.equal(snap.lastText, "OK");
  const retries = snap.notices.filter((n) => /provider retry/.test(n.message));
  assert.equal(retries.length, 2, "two retries happened");
  assert.match(retries[1].message, /: 503 Error 524: A timeout occurred$/);
  assert.match(retries[0].message, /: 500: overloaded$/);
  assert.ok(retries.every((n) => n.message.length <= 300), retries.map((n) => n.message).join("\n"));
  assert.equal(snap.turns, 1, "retries do not spend turns");
  assert.equal(snap.remainingTurns, 4);
  console.log("  OK -> provider retries do not spend the turn budget; retry notices stay short");
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
