import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = await mkdtemp(join(tmpdir(), "pi-resources-"));
const requests = [];
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({
    id: "resources", object: "chat.completion.chunk", created: 1, model: "one",
    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
  })}\n\n`);
  emit({ role: "assistant", content: "OK" }); emit({}, "stop");
  emit({}, null, { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const agentDir = join(dir, "agent"), skillDir = join(dir, "chosen");
const context = join(dir, "rules.md"), skill = join(skillDir, "SKILL.md");
const resources = { contextFiles: [context], skills: [skill] };
const clients = [];
const open = async () => {
  const client = new Client({ name: "resources", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore", env: {
    ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
    PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0",
  } }));
  clients.push(client);
  const raw = (name, args) => client.callTool({ name, arguments: args });
  const call = async (name, args) => {
    const result = await raw(name, args);
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  return { client, call, raw };
};
try {
  await mkdir(agentDir); await mkdir(skillDir);
  await writeFile(context, "SELECTED_CONTEXT_RULE");
  await writeFile(skill, "---\nname: chosen\ndescription: SELECTED_SKILL_DESCRIPTION\n---\nSELECTED_SKILL_BODY\n");
  await writeFile(join(agentDir, "AGENTS.md"), "UNSELECTED_GLOBAL_RULE");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 32000,
      maxTokens: 1024, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const { call, raw, client } = await open();
  const run = (extra = {}) => call("run", { cwd: dir, tools: ["read"], prompt: "answer", ...extra });
  const system = () => JSON.stringify(requests.at(-1).messages.filter((m) => m.role === "system"));
  await run();
  assert.doesNotMatch(system(), /SELECTED_CONTEXT_RULE|SELECTED_SKILL_DESCRIPTION|UNSELECTED_GLOBAL_RULE/);
  const parent = await run({ id: "parent", resources, durable: true, verbose: true });
  assert.match(system(), /SELECTED_CONTEXT_RULE/); assert.match(system(), /SELECTED_SKILL_DESCRIPTION/);
  assert.doesNotMatch(system(), /UNSELECTED_GLOBAL_RULE|SELECTED_SKILL_BODY/);
  assert.ok(parent.contextUsage?.contextWindow === 32000, "verbose run exposes SDK context diagnostics");
  assert.equal((await call("status", { sessionId: "parent" })).contextUsage, undefined);
  assert.ok((await call("wait", { sessionId: "parent", verbose: true })).contextUsage);
  await run({ forkFrom: "parent" }); assert.match(system(), /SELECTED_CONTEXT_RULE/);
  await run({ forkFrom: "parent", resources: {} }); assert.doesNotMatch(system(), /SELECTED_CONTEXT_RULE|SELECTED_SKILL_DESCRIPTION/);
  await run({ resources, prompt: "/skill:chosen verify" });
  assert.match(JSON.stringify(requests.at(-1).messages), /SELECTED_SKILL_BODY/);

  const batch = await call("spawn_batch", { cwd: dir, resources, tools: ["read"], tasks: [{ prompt: "with resources" }, { prompt: "without", resources: {} }] });
  await call("wait", { sessionIds: batch.sessionIds, until: "all_settled" });
  const batchRequests = requests.slice(-2);
  assert.equal(batchRequests.filter((r) => JSON.stringify(r.messages).includes("SELECTED_CONTEXT_RULE")).length, 1);
  const secret = join(dir, ".env.local"), alias = join(dir, "alias.md");
  await writeFile(secret, "FAKE_PRIVATE_KEY"); await symlink(secret, alias);
  for (const bad of [{ contextFiles: [alias] }, { skills: [alias] }, { skills: [context] }, { contextFiles: ["relative.md"] }]) {
    const result = await raw("spawn", { cwd: dir, prompt: "refused", resources: bad });
    assert.equal(result.isError, true, JSON.stringify(result));
  }
  const noReader = await raw("spawn", { cwd: dir, prompt: "refused", tools: [], resources });
  assert.match(noReader.content[0].text, /requires.*read or bash/);
  const before = requests.length;
  const refusedBatch = await raw("spawn_batch", { cwd: dir, tasks: [{ prompt: "never starts" }, { prompt: "bad", resources: { contextFiles: [join(dir, "missing.md")] } }] });
  assert.equal(refusedBatch.isError, true); assert.equal(requests.length, before, "invalid resource stops the batch before any request");

  await client.close();
  const reopened = await open();
  await writeFile(context, "UPDATED_SELECTED_CONTEXT");
  await reopened.call("follow_up", { sessionId: "parent", prompt: "after reconnect" });
  await reopened.call("wait", { sessionId: "parent", until: "settled" });
  assert.match(system(), /UPDATED_SELECTED_CONTEXT/);
  assert.match(system(), /SELECTED_SKILL_DESCRIPTION/);
  console.log("  OK -> explicit resources stay opt-in, inherit/clear on fork/batch, reject secrets before launch and survive durable reconnect; verbose context diagnostics");
} finally {
  for (const client of clients) await client.close().catch(() => {});
  http.closeAllConnections(); await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
