import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Each MCP process stands for one Claude/Codex window.
const directory = await mkdtemp(join(tmpdir(), "pi-delegate-handoff-"));
const agentDir = join(directory, "agent");
const repo = join(directory, "repo");
const clients = new Set();
const sockets = new Set();
const waitUntil = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Handoff fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (body.includes("HOLD")) return;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "OK" }, null], [{}, "stop"]])
    res.write(`data: ${JSON.stringify({ id: "handoff", object: "chat.completion.chunk", created: 1, model: "one",
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));

const window = async (env = {}) => {
  const client = new Client({ name: "handoff-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(directory, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", ...env } });
  const host = { client, transport };
  clients.add(host);
  await client.connect(transport);
  host.call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  return host;
};
const close = async (host) => { await host.client.close(); clients.delete(host); };
const crash = async (host) => {
  process.kill(host.transport.pid, "SIGKILL");
  await waitUntil(() => { try { process.kill(host.transport.pid, 0); return false; } catch { return true; } });
  await close(host);
};
const settle = (host, id) => host.call("wait", { sessionId: id, until: "settled", timeoutMs: 15000 });
const save = (host, sessionId, name) => host.call("handoff", { action: "save", cwd: repo, name, sessionId,
  goal: `goal of ${sessionId}`, completed: "read the code", next: "fix the bug" });
const read = (host, name) => host.call("handoff", { action: "read", cwd: repo, ...(name ? { name } : {}) });

try {
  await mkdir(agentDir, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000,
      maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));

  // Nothing saved yet; saving needs a real session.
  let old = await window();
  assert.equal((await read(old)).found, false);
  await assert.rejects(() => save(old, "nope"), /Unknown sessionId/);

  // 1. A memory-only session cannot cross windows, and saving it says so.
  await old.call("spawn", { cwd: repo, id: "memo", prompt: "plain", tools: [] });
  await settle(old, "memo");
  assert.match((await save(old, "memo", "memo")).warning, /memory-only/);
  assert.equal((await read(old, "memo")).resumeHint, "status_then_follow_up", "the window that runs it can continue");

  // 2. A finished durable session is read and continued from a new window.
  await old.call("spawn", { cwd: repo, id: "finished", prompt: "plain", tools: [], durable: true });
  await settle(old, "finished");
  await save(old, "finished", "finished");
  await close(old);
  let fresh = await window();
  assert.equal((await read(fresh, "memo")).resumeHint, "session_not_recoverable");
  const finished = await read(fresh, "finished");
  assert.equal(finished.resumeHint, "status_then_follow_up");
  assert.equal(finished.handoff.next, "fix the bug");
  assert.equal((await fresh.call("status", { sessionId: "finished" })).lastText, "OK");
  await close(fresh);

  // 3. The previous window is still open and its session still runs: hand back, do not grab it.
  old = await window();
  await old.call("spawn", { cwd: repo, id: "running", prompt: "HOLD", tools: [], durable: true });
  await save(old, "running", "running");
  fresh = await window();
  assert.equal((await read(fresh, "running")).resumeHint, "old_process_owns_session");
  await close(fresh);

  // 4. The previous window crashed: the new one recovers the session and waits on it.
  await crash(old);
  fresh = await window();
  assert.equal((await read(fresh, "running")).resumeHint, "wait_running_session");

  // 5. Unfinished and unowned, waiting for a free slot: two abandoned, room for one.
  await fresh.call("spawn", { cwd: repo, id: "running-2", prompt: "HOLD again", tools: [], durable: true });
  await save(fresh, "running-2", "running-2");
  await crash(fresh);
  fresh = await window({ PI_DELEGATE_MAX_CONCURRENT: "1" });
  const hints = [(await read(fresh, "running")).resumeHint, (await read(fresh, "running-2")).resumeHint].sort();
  assert.deepEqual(hints, ["awaiting_recovery", "wait_running_session"]);
  await close(fresh);

  // 6. Forgotten, and the id later reused for different work: the note does not follow the new session.
  fresh = await window();
  await fresh.call("forget", { sessionId: "finished" });
  assert.equal((await read(fresh, "finished")).resumeHint, "session_missing");
  await fresh.call("spawn", { cwd: repo, id: "finished", prompt: "plain", tools: [], durable: true });
  await settle(fresh, "finished");
  assert.equal((await read(fresh, "finished")).resumeHint, "session_missing", "a reused id is a different session");
  await close(fresh);
  fresh = await window();
  assert.equal((await read(fresh, "finished")).resumeHint, "session_missing", "also when only the catalog knows the new one");

  // 7. read without a name returns the newest; a symlinked or trailing-slash cwd finds the same notes.
  await save(fresh, "finished", "newest");
  const newest = await read(fresh);
  assert.equal(newest.handoff.name, "newest");
  assert.ok(newest.names.includes("running") && newest.names.length === 5);
  await symlink(repo, join(directory, "repo-link"));
  assert.equal((await fresh.call("handoff", { action: "read", cwd: join(directory, "repo-link") + "/" })).handoff.name, "newest");
  await assert.rejects(() => fresh.call("handoff", { action: "save", cwd: repo, sessionId: "finished" }), /needs sessionId, goal, completed and next/);
  await close(fresh);
  console.log("  OK -> handoff: memory-only warned, finished resumed, live owner respected, crash recovered, awaiting slot, id reuse, newest/named, cwd normalised");
} finally {
  for (const host of clients) await host.client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
