import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveDirPath } from "../dist/save.js";

const dir = await mkdtemp(join(tmpdir(), "pi-delegate-save-"));
const text = `  Final result: café 📝\n${"Keep the answer out of the caller's context.\n".repeat(64)}  `;
const sockets = new Set();
let hangStarted;
const hanging = new Promise((resolve) => { hangStarted = resolve; });
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  if (body.includes("HANG")) { hangStarted(); return; }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "save", object: "chat.completion.chunk", created: 1, model: request.model,
    choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  emit({ role: "assistant", content: body.includes("EMPTY") ? " \n\t " : text });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "save", version: "1" });
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0" } }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const saved = async (result, path) => {
    assert.equal(result.state, "done");
    assert.equal(result.savedTo, path);
    assert.equal(result.savedChars, text.length);
    assert.ok(!Object.hasOwn(result, "lastText"));
    assert.ok(!Object.hasOwn(result, "saveError"));
    assert.equal(await readFile(path, "utf8"), text);
  };
  const absent = async (path) => assert.rejects(readFile(path), { code: "ENOENT" });
  const settle = async (id, options = {}) => {
    let result;
    do result = await call("wait", { sessionId: id, until: "settled", timeoutMs: 15000, ...options });
    while (result.nextAction === "wait");
    return result;
  };

  const raw = (name, args) => client.callTool({ name, arguments: args });

  // run: the destination is declared with the work; compact results carry savedTo, verbose keeps the text.
  const runPath = join(dir, "run", "result.md");
  await saved(await call("run", { cwd: dir, id: "run", prompt: "answer", tools: [], saveTo: runPath }), runPath);
  const verboseRun = await call("run", { cwd: dir, prompt: "answer", tools: [], saveTo: join(dir, "run", "v.md"), verbose: true });
  assert.deepEqual([verboseRun.savedTo, verboseRun.lastText], [join(dir, "run", "v.md"), text]);
  assert.ok(!Object.hasOwn(await call("status", { sessionId: "run" }), "lastText"), "compact status does not repeat it");
  assert.equal((await call("status", { sessionId: "run", verbose: true })).lastText, text);

  // spawn + wait; then a follow_up with its own file, and one without saveTo returns inline again.
  const spawnPath = join(dir, "spawn", "first.md");
  await call("spawn", { cwd: dir, id: "single", prompt: "answer", tools: [], saveTo: spawnPath });
  await saved(await settle("single"), spawnPath);
  const followPath = join(dir, "spawn", "second.md");
  await call("follow_up", { sessionId: "single", prompt: "again", saveTo: followPath });
  await saved(await settle("single"), followPath);
  await call("follow_up", { sessionId: "single", prompt: "again" });
  const inline = await settle("single");
  assert.deepEqual([inline.lastText, inline.savedTo], [text, undefined]);

  // spawn_batch with saveDir: one file per session.
  const saveDir = join(dir, "batch", "results");
  const batch = await call("spawn_batch", { cwd: dir, tools: [], idPrefix: "batch", saveDir,
    tasks: [{ prompt: "answer one" }, { prompt: "answer two" }] });
  const ids = batch.sessions.map((s) => s.sessionId);
  const result = await call("wait", { sessionIds: ids, until: "all_settled", timeoutMs: 15000 });
  for (const session of result.sessions) await saved(session, join(saveDir, `${session.sessionId}.md`));

  // Bad destinations are refused before anything starts; secrets are never written.
  const secret = join(dir, ".env");
  await writeFile(secret, "do not overwrite");
  const alias = join(dir, "secret-alias.md");
  await symlink(secret, alias);
  // A dangling link to a secret name must not be followed into creating it.
  const dangling = join(dir, "dangling.md");
  await symlink(join(dir, "nested", ".env"), dangling);
  for (const [saveTo, error] of [["relative.md", /absolute path/], [secret, /secret path/], [alias, /secret path/], [dangling, /secret path/]]) {
    for (const [name, args] of [["run", { cwd: dir, prompt: "answer", tools: [] }], ["spawn", { cwd: dir, prompt: "answer", tools: [] }],
      ["follow_up", { sessionId: "run", prompt: "again" }]]) {
      const refused = await raw(name, { ...args, saveTo });
      assert.equal(refused.isError, true, `${name} ${saveTo}`);
      assert.match(refused.content[0].text, error);
    }
  }
  const badBatch = await raw("spawn_batch", { cwd: dir, tools: [], saveDir: "relative", tasks: [{ prompt: "answer" }] });
  assert.equal(badBatch.isError, true);
  assert.equal(await readFile(secret, "utf8"), "do not overwrite");
  await absent(join(dir, "nested", ".env"));

  // A failed write keeps the answer inline.
  const blockedParent = join(dir, "not-a-directory");
  await writeFile(blockedParent, "a file");
  const failed = await call("run", { cwd: dir, prompt: "answer", tools: [], saveTo: join(blockedParent, "result.md") });
  assert.equal(failed.lastText, text);
  assert.match(failed.saveError, /ENOTDIR|EEXIST/);

  // No text, nothing written; a running session writes nothing yet.
  const emptyPath = join(dir, "empty", "result.md");
  const empty = await call("run", { cwd: dir, prompt: "EMPTY", tools: [], saveTo: emptyPath });
  assert.deepEqual([empty.state, empty.savedTo], ["done", undefined]);
  await absent(emptyPath);
  const runningPath = join(dir, "running", "result.md");
  await call("spawn", { cwd: dir, id: "running", prompt: "HANG", tools: [], saveTo: runningPath });
  await hanging;
  assert.equal((await call("status", { sessionId: "running" })).state, "running");
  await absent(runningPath);
  await call("abort", { sessionId: "running" });
  await absent(runningPath);

  // wait and status stay read-only: they never write.
  const { tools } = await client.listTools();
  for (const name of ["wait", "status"]) assert.equal(tools.find((t) => t.name === name).annotations.readOnlyHint, true);

  assert.equal(saveDirPath(dir, "safe._:-id"), join(dir, "safe._:-id.md"));
  for (const id of ["../escape", "a/b", "a\\b"])
    assert.throws(() => saveDirPath(dir, id), /path separator/);
  console.log("  OK -> saveTo on run/spawn/follow_up and saveDir on spawn_batch write the final text; results show savedTo; bad paths refused up front; failed writes keep the answer");
} finally {
  await client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
