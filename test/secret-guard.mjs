import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// PI_DELEGATE_SECRET_GUARD, given raw as the argument (none: unset). Only "0" turns the guard off:
// then tool paths, grep, attachments, saveTo and the tool_call extension stop checking secret paths.
const value = process.argv[2];
const guarded = value !== "0";
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-secret-guard-"));
const repo = join(dir, "repo");
const home = join(dir, "home");
const agentDir = join(dir, "agent");
delete process.env.PI_DELEGATE_SECRET_GUARD;
if (value !== undefined) process.env.PI_DELEGATE_SECRET_GUARD = value;
Object.assign(process.env, { HOME: home, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state") });
const { assertToolPathsAllowed, blockedSecretPath } = await import("../dist/secrets.js");
const { createProtectedGrepTool } = await import("../dist/pi/search.js");
const { withAttachments } = await import("../dist/attachments.js");
const { checkSavePath, saveText } = await import("../dist/save.js");
const { loadResources } = await import("../dist/pi/session.js");

const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "guard", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const path = body.match(/READ_PATH=([^;]+);/)?.[1];
  if (path && request.messages.at(-1).role !== "tool") {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: "call_read", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path }) } }] });
    emit({}, "tool_calls");
  } else {
    emit({ role: "assistant", content: `TOOL SAID ${JSON.stringify(request.messages.at(-1).content)}` });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "secret-guard", version: "1" });
try {
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(repo);
  await mkdir(agentDir);
  const env = join(repo, ".env");
  const key = join(home, ".ssh", "id_fake");
  await writeFile(env, "TEST_MARKER FAKE_SECRET_ENV\n");
  await writeFile(key, "TEST_MARKER FAKE_SECRET_SSH\n");
  await writeFile(join(repo, "public.txt"), "TEST_MARKER public\n");

  // The path checks every site shares.
  for (const path of [env, ".env", key]) assert.equal(Boolean(blockedSecretPath(path, repo)), guarded, path);
  for (const path of [env, key]) {
    const check = () => assertToolPathsAllowed("read", { path }, repo);
    if (guarded) assert.throws(check, /private credential path/);
    else check();
  }

  // grep: secret files are excluded from a recursive search, and a secret path is refused.
  const grep = createProtectedGrepTool(repo);
  const runGrep = (input) => grep.execute("test", input, new AbortController().signal, undefined, { cwd: repo });
  const inRepo = (await runGrep({ pattern: "TEST_MARKER" })).content[0].text;
  assert.match(inRepo, /public\.txt/);
  const inHome = (await runGrep({ pattern: "TEST_MARKER", path: home })).content[0].text;
  if (guarded) {
    assert.doesNotMatch(inRepo, /FAKE_SECRET/);
    assert.doesNotMatch(inHome, /FAKE_SECRET/);
    await assert.rejects(() => runGrep({ pattern: "TEST_MARKER", path: ".env" }), /private credential path/);
  } else {
    assert.match(inRepo, /FAKE_SECRET_ENV/);
    assert.match(inHome, /FAKE_SECRET_SSH/);
    assert.match((await runGrep({ pattern: "TEST_MARKER", path: ".env" })).content[0].text, /FAKE_SECRET_ENV/);
  }

  // Attachments and saveTo.
  for (const [path, marker] of [[env, /FAKE_SECRET_ENV/], [key, /FAKE_SECRET_SSH/]]) {
    if (guarded) await assert.rejects(() => withAttachments("x", [path]), /secret path/);
    else assert.match(await withAttachments("x", [path]), marker);
  }
  const saved = join(home, ".ssh", "saved.md");
  for (const path of [join(repo, ".env.result"), saved]) {
    if (guarded) assert.throws(() => checkSavePath(path), /secret path/);
    else checkSavePath(path);
  }
  if (guarded) await assert.rejects(() => saveText(saved, "saved"), /secret path/);
  else {
    await saveText(saved, "saved");
    assert.equal(await readFile(saved, "utf8"), "saved");
  }

  // The tool_call guard is the only inline extension of a session without tools, and is left out when off.
  const loader = await loadResources({ cwd: repo, tools: [], extensions: false, nativeMcp: false, mcpServers: [],
    resources: undefined, customTools: [], journal: undefined });
  assert.equal(loader.getExtensions().extensions.length, guarded ? 1 : 0, "secret-path guard installed");

  // End to end: a delegate's read of a secret path, and what init reports.
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0" } }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  for (const [path, marker] of [[env, /FAKE_SECRET_ENV/], [key, /FAKE_SECRET_SSH/]]) {
    const result = await call("run", { cwd: repo, prompt: `READ_PATH=${path};`, tools: ["read"] });
    assert.equal(result.state, "done", JSON.stringify(result.error));
    if (guarded) {
      assert.doesNotMatch(result.lastText, /FAKE_SECRET/);
      assert.match(result.lastText, /private credential path/);
    } else assert.match(result.lastText, marker);
  }
  const spawnTool = (await client.listTools()).tools.find((tool) => tool.name === "spawn");
  assert.equal(/secret paths are refused/.test(spawnTool.inputSchema.properties.attachments.description), guarded);
  const init = await call("init", { cwd: repo });
  assert.equal(init.permissions.secretPathGuard, guarded ? "on" : "off (PI_DELEGATE_SECRET_GUARD=0)");
  assert.equal(init.gotchas.some((line) => /Credential paths .* are blocked/.test(line)), guarded);
  console.log(`  OK -> PI_DELEGATE_SECRET_GUARD=${value ?? "(unset)"}: secret paths ${guarded ? "blocked" : "allowed"} in tools, grep, attachments, saveTo and init`);
} finally {
  await client.close().catch(() => {});
  http.closeAllConnections?.();
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
