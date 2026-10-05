import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Running delegates report idleMs and phase. With PI_DELEGATE_STALL_MS set, a model request that
// produces no stream event for that long ends the run as "stalled"; one that keeps streaming does not.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-liveness-"));
const sockets = new Set();
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "live", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (body.includes("HANG")) return; // accepts the request and never answers
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (body.includes("SLOW")) {
    // Streams a word every 300 ms for about 2.4 s, longer than the stall limit in total.
    for (let i = 0; i < 8; i++) { emit({ role: "assistant", content: `w${i} ` }); await new Promise((r) => setTimeout(r, 300)); }
  } else emit({ role: "assistant", content: "OK" });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "liveness", version: "1" });
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "1500" } }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const settle = async (id) => {
    let snap;
    do snap = await call("wait", { sessionId: id, until: "settled", timeoutMs: 10000 }); while (snap.nextAction === "wait");
    return snap;
  };

  // A hung request: idleMs grows in phase "model", then the run ends as stalled.
  await call("spawn", { cwd: dir, id: "hung", prompt: "HANG", tools: [] });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const live = await call("wait", { sessionId: "hung", timeoutMs: 250 });
  assert.equal(live.phase, "model");
  assert.ok(live.idleMs >= 500, `idleMs ${live.idleMs}`);
  const hung = await settle("hung");
  assert.equal(hung.state, "aborted");
  assert.equal(hung.termination.reason, "stalled");
  assert.equal(hung.idleMs, undefined, "a finished run reports no liveness");
  assert.equal(hung.canFollowUp, true, "a stalled run can be continued");

  // A slow but streaming request is not stalled.
  await call("spawn", { cwd: dir, id: "slow", prompt: "SLOW", tools: [] });
  const slow = await settle("slow");
  assert.equal(slow.state, "done", JSON.stringify(slow.termination));
  console.log("  OK -> running delegates report idleMs and phase; PI_DELEGATE_STALL_MS ends a silent request as stalled, not a streaming one");
} finally {
  await client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
