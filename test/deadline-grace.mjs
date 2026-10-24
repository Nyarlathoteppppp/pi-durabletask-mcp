import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A deadline guards against a hung provider. Opt-in: when it passes, the run loses its tools and
// gets a grace period to answer, instead of being aborted with its work.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-deadline-grace-"));
const requests = {};
const followTools = [];
const sockets = new Set();
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const prompt = JSON.stringify(request.messages.filter((m) => m.role === "user").map((m) => m.content));
  // A follow-up's conversation also holds the run before it, so FOLLOW is matched first.
  const kind = ["FOLLOW", "LOOP", "SLOWANSWER", "HANG", "QUESTION"].find((k) => prompt.includes(k));
  requests[kind] = (requests[kind] ?? 0) + 1;
  const results = request.messages.filter((m) => m.role === "tool").length;
  if (kind === "HANG") return; // never answers
  if (kind === "FOLLOW") followTools.push((request.tools ?? []).map((t) => t.function.name));
  await new Promise((resolve) => setTimeout(resolve, kind === "SLOWANSWER" ? 2500 : kind === "FOLLOW" ? 0 : 700));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "d", object: "chat.completion.chunk",
    created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  // LOOP keeps calling ls while it has tools; QUESTION asks the caller once; SLOWANSWER answers in its
  // first, slow request; FOLLOW answers at once.
  const tool = kind === "LOOP" && request.tools?.length ? ["ls", { path: dir }]
    : kind === "QUESTION" && request.tools?.length && !results ? ["ask_human", {}] : undefined;
  if (tool) {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: `call_${results}`, type: "function",
      function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] });
    emit({}, "tool_calls");
  } else {
    // Without tools, a run answers only when told this is its last turn, as a real model needs to be.
    const told = request.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("This is your last turn"));
    emit({ role: "assistant", content: ["SLOWANSWER", "FOLLOW"].includes(kind) ? `${kind} DONE` : told ? `${kind} ANSWER` : "I will keep looking." });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const clients = [];
try {
  const agentDir = join(dir, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  // A tool that waits for the caller's reply.
  await writeFile(join(agentDir, "extensions", "ask.ts"), `
    export default function(pi) { pi.registerTool({ name: "ask_human", label: "Ask", description: "Asks the caller",
      parameters: { type: "object", properties: {} },
      async execute(id, args, signal, onUpdate, ctx) {
        const reply = await ctx.ui.input("Which file?");
        return { content: [{ type: "text", text: reply ?? "no reply" }], details: {} };
      } }); }
  `);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const connect = async (env) => {
    const client = new Client({ name: "deadline-grace", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
      env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
        PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0", ...env } }));
    clients.push(client);
    return client;
  };
  let client;
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const run = (prompt) => call("run", { cwd: dir, prompt, tools: ["ls"], maxTurns: 40, maxDurationMs: 1500, verbose: true });
  /** A wait settles on a question too; this one waits for the run to end. */
  const settle = async (sessionId) => {
    for (;;) {
      const s = await call("wait", { sessionId, until: "settled", verbose: true });
      if (!["starting", "running"].includes(s.state)) return s;
    }
  };
  const deadlineNotices = (r) => r.notices.filter((n) => /^deadline /.test(n.message));

  // Off by default: the deadline aborts as before.
  client = await connect({});
  const hard = await run("LOOP");
  assert.equal(hard.state, "aborted");
  assert.equal(hard.termination.reason, "deadline");
  assert.equal(deadlineNotices(hard).length, 0);

  client = await connect({ PI_DELEGATE_DEADLINE_GRACE_MS: "4000", PI_DELEGATE_ALLOW_TOOLS: "ask_human" });
  // Still investigating at the deadline: the tool turn under way ends, then it answers without tools.
  const loop = await run("LOOP");
  assert.equal(loop.state, "done", JSON.stringify(loop.termination ?? loop.error ?? null));
  assert.equal(loop.lastText, "LOOP ANSWER");
  assert.ok(loop.elapsedMs > 1500);
  assert.equal(deadlineNotices(loop).length, 1, JSON.stringify(loop.notices));
  // The request under way at the deadline still offered tools; the call it returned does not start.
  const blocked = loop.toolCalls.at(-1);
  assert.equal(blocked.state, "error", JSON.stringify(loop.toolCalls));
  assert.match(String(blocked.result), /deadline/);

  // The next run has its own deadline, and its tools again.
  await call("follow_up", { sessionId: loop.sessionId, prompt: "FOLLOW" });
  const followed = await settle(loop.sessionId);
  assert.equal(followed.lastText, "FOLLOW DONE");
  assert.deepEqual(followTools, [["ls"]]);

  // A question pending at the deadline is withdrawn, so the run can still answer.
  const { sessionId: asking } = await call("spawn", { cwd: dir, prompt: "QUESTION", tools: ["ask_human"], extensions: true,
    maxTurns: 40, maxDurationMs: 1500 });
  const asked = await settle(asking);
  assert.equal(asked.state, "done", JSON.stringify(asked.termination ?? asked.error ?? null));
  assert.equal(asked.lastText, "QUESTION ANSWER");

  // Already writing its answer at the deadline: that answer stands, without an extra turn.
  const slow = await run("SLOWANSWER");
  assert.equal(slow.state, "done");
  assert.equal(slow.lastText, "SLOWANSWER DONE");
  assert.equal(requests.SLOWANSWER, 1, "no extra turn was asked of a run that was answering");

  // A model that never answers is still aborted, once the grace has passed too.
  const hang = await run("HANG");
  assert.equal(hang.state, "aborted");
  assert.equal(hang.termination.reason, "deadline");
  assert.ok(hang.termination.observed >= 1500 + 4000 - 100, `aborted at ${hang.termination.observed} ms`);
  console.log("  OK -> with PI_DELEGATE_DEADLINE_GRACE_MS, a run past its deadline starts no more tools and gets a grace period to answer; a hung one is still aborted");
} finally {
  for (const c of clients) await c.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
