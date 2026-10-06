import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// codemode over the built-in tools, without native MCP: one script call runs several reads, the
// nested calls appear in the trace under their script, and only the script counts toward maxToolCalls.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-codemode-"));
const sockets = new Set();
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "cm", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (request.messages.at(-1).role !== "tool") {
    const code = body.includes("SECRET")
      ? 'try { return await tools.read({ path: ".env" }); } catch (e) { return "BLOCKED " + e.message; }'
      : 'const [a, b] = await Promise.all([tools.read({ path: "a.txt" }), tools.read({ path: "b.txt" })]); return a + "|" + b;';
    emit({ role: "assistant", tool_calls: [{ index: 0, id: "call_script", type: "function",
      function: { name: "codemode", arguments: JSON.stringify({ code }) } }] });
    emit({}, "tool_calls");
  } else {
    emit({ role: "assistant", content: `SCRIPT SAID ${JSON.stringify(request.messages.at(-1).content)}` });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "codemode", version: "1" });
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(dir, "a.txt"), "ALPHA\n");
  await writeFile(join(dir, "b.txt"), "BRAVO\n");
  await writeFile(join(dir, ".env"), "TOKEN=FAKE_SECRET_DO_NOT_RETURN\n");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_ALLOW_TOOLS: "codemode",
      PI_DELEGATE_DEFAULT_TOOLS: "read,grep,find,ls,codemode" } }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  for (const durable of [false, true]) {
    const id = `script-${durable}`;
    await call("spawn", { cwd: dir, id, prompt: "read both", tools: ["read", "codemode"], maxToolCalls: 5, durable });
    let snap;
    do snap = await call("wait", { sessionId: id, until: "settled", timeoutMs: 15000 }); while (snap.nextAction === "wait");
    const full = await call("status", { sessionId: id, verbose: true });
    assert.equal(full.state, "done", JSON.stringify(full.error));
    assert.match(full.lastText, /ALPHA[\s\S]*BRAVO/, "the script's reads reached the model");
    const script = full.toolCalls.find((c) => c.name === "codemode");
    assert.equal(script?.state, "ok");
    const nested = full.toolCalls.filter((c) => c.parentToolCallId === script.id);
    assert.equal(nested.length, 2, `durable=${durable}: nested reads recorded under the script`);
    assert.ok(nested.every((c) => c.name === "read" && c.state === "ok"));
  }
  // A script's nested reads pass the same secret-path guard as direct calls.
  await call("spawn", { cwd: dir, id: "secret", prompt: "SECRET", tools: ["read", "codemode"] });
  let secret;
  do secret = await call("wait", { sessionId: "secret", until: "settled", timeoutMs: 15000 }); while (secret.nextAction === "wait");
  assert.doesNotMatch(secret.lastText, /FAKE_SECRET_DO_NOT_RETURN/);
  assert.match(secret.lastText, /BLOCKED/);

  // PI_DELEGATE_DEFAULT_TOOLS sets the tools of a call that names none.
  const byDefault = await call("spawn", { cwd: dir, id: "default-tools", prompt: "read both" });
  assert.deepEqual([...byDefault.activeTools].sort(), ["codemode", "find", "grep", "ls", "read"]);

  // Without permission, codemode is refused like any other tool.
  const refused = await client.callTool({ name: "spawn", arguments: { cwd: dir, prompt: "x", tools: ["read", "bash"] } });
  assert.equal(refused.isError, true);
  console.log("  OK -> codemode without native MCP: one script runs several reads, nested calls are traced under it");
} finally {
  await client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
