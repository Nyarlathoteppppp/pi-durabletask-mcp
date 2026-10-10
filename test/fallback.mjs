import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A run whose provider keeps failing after Pi's own retries continues, in the same session, on the
// first fallback model of another provider; the caller's session id and wait do not change.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-fallback-"));
const seen = [];
const server = (name, healthy) => createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  seen.push({ provider: name, messages: request.messages.length, tools: request.tools?.length ?? 0,
    text: JSON.stringify(request.messages.findLast((m) => m.role === "user")?.content) });
  if (!healthy) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end('{"error":{"message":"gateway down"}}'); }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk",
    created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  emit({ role: "assistant", content: `ANSWER FROM ${name}` });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
const servers = { down: server("down", false), alsodown: server("alsodown", false), up: server("up", true) };
for (const http of Object.values(servers)) await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const model = (id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const provider = (name) => ({ baseUrl: `http://127.0.0.1:${servers[name].address().port}/v1`, api: "openai-completions",
  apiKey: "fake-key", models: [model("m1"), model("m2")] });
const clients = [];
const connect = async (env = {}) => {
  const client = new Client({ name: "fallback", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DELEGATE_STATE_DIR: join(dir, "state"),
      PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0", ...env } }));
  clients.push(client);
  return async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
};
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "down", defaultModel: "m1",
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    down: provider("down"), alsodown: provider("alsodown"), up: provider("up") } }));

  // 1. Server default: same-provider entries are skipped, a failing fallback is passed over, the
  //    first healthy one answers in the same session, and the switch is visible.
  let call = await connect({ PI_DELEGATE_FALLBACK_MODELS: "down/m2,alsodown/*,up/*" });
  const result = await call("run", { cwd: dir, model: "down/m1", prompt: "hello", tools: [], maxTurns: 6, verbose: true });
  assert.equal(result.state, "done", result.error);
  assert.equal(result.lastText, "ANSWER FROM up");
  assert.equal(result.model, "up/m1");
  assert.deepEqual([...new Set(seen.map((s) => s.provider))], ["down", "alsodown", "up"], "down/m2 shares the failed provider");
  const switches = result.notices.filter((n) => /continuing on/.test(n.message)).map((n) => n.message);
  assert.equal(switches.length, 2);
  assert.match(switches[0], /^down\/m1 provider error: .*gateway down.*; continuing on alsodown\/m1$/);
  assert.match(switches[1], /^alsodown\/m1 provider error: .*; continuing on up\/m1$/);
  const continued = seen.find((s) => s.provider === "up");
  assert.match(continued.text, /previous model stopped on a provider error/);
  assert.ok(continued.messages > 2, "the fallback model receives the conversation so far");

  // 2. A per-call list overrides the default; [] turns fallback off and the error stands.
  const off = await call("run", { cwd: dir, model: "down/m1", prompt: "hello", tools: [], fallbackModels: [] });
  assert.equal(off.state, "error");
  assert.match(off.error, /gateway down/);

  // 3. Entries that match no usable model are reported at start, without refusing the launch.
  const stale = await call("run", { cwd: dir, model: "up/m1", prompt: "hello", tools: [], fallbackModels: ["gone/*", "up/m2"], verbose: true });
  assert.equal(stale.state, "done");
  assert.ok(stale.notices.some((n) => n.type === "warning" && /fallback gone\/\* matches no model in scope/.test(n.message)));
  // 4. With no turn left, the provider error stands: a fallback could not answer anyway.
  const last = await call("run", { cwd: dir, model: "down/m1", prompt: "hello", tools: [], maxTurns: 1, verbose: true });
  assert.equal(last.state, "error", `${last.state} turns=${last.turns} ${last.lastText}`);
  assert.match(last.error, /gateway down/);
  assert.ok(!last.notices.some((n) => /continuing on/.test(n.message)));

  // 5. A continuation on the last turn answers without tools, like any last turn.
  seen.length = 0;
  const lastTurn = await call("run", { cwd: dir, model: "down/m1", prompt: "hello", tools: ["read"], maxTurns: 2, fallbackModels: ["up/*"] });
  assert.equal(lastTurn.state, "done", lastTurn.error);
  assert.equal(seen.find((s) => s.provider === "up").tools, 0, "the fallback's last turn has no tools");

  // 6. A fork inherits its parent's fallback list.
  const plain = await connect();
  await plain("run", { cwd: dir, id: "parent", model: "up/m1", prompt: "hello", tools: [], fallbackModels: ["up/*"] });
  const child = await plain("run", { forkFrom: "parent", model: "down/m1", prompt: "again", verbose: true });
  assert.equal(child.state, "done", child.error);
  assert.equal(child.model, "up/m1");

  // 7. init shows what each default entry resolves to now, so a stale one is visible after a model update.
  const init = await call("init", { cwd: dir });
  assert.deepEqual(init.models.fallbackOnProviderError, [{ pattern: "down/m2", now: "down/m2" },
    { pattern: "alsodown/*", now: "alsodown/m1" }, { pattern: "up/*", now: "up/m1" }]);
  console.log("  OK -> provider failures continue on the next fallback model of another provider, in the same session");
} finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const http of Object.values(servers)) await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
