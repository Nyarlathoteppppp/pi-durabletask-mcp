import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const policy = process.argv[2];
const dir = await mkdtemp(join(tmpdir(), "pi-default-policy-"));
const agent = join(dir, "agent");
delete process.env.PI_DELEGATE_MODEL;
delete process.env.PI_DELEGATE_MODEL_ALLOWLIST;
delete process.env.PI_DELEGATE_MODEL_DENYLIST;
Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agent,
  PI_DELEGATE_STATE_DIR: join(dir, "state"), PI_DELEGATE_STRICT_SCOPE: "1", PI_DELEGATE_IGNORE_SCOPE: "0" });
if (policy === "allow") process.env.PI_DELEGATE_MODEL_ALLOWLIST = "test/two";
else if (policy === "deny") process.env.PI_DELEGATE_MODEL_DENYLIST = "test/one";
else assert.equal(policy, "scope");
let requests = 0;
const http = createServer(async (req, res) => {
  for await (const _chunk of req) {};
  requests++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "OK" }, null], [{}, "stop"]]) {
    res.write(`data: ${JSON.stringify({ id: "default-policy", object: "chat.completion.chunk", created: 1,
      model: "two", choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
});
await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
let registry;
try {
  await mkdir(agent);
  const settings = model => JSON.stringify({ defaultProvider: "test", defaultModel: model,
    defaultThinkingLevel: "off", enabledModels: ["test/*"] });
  await writeFile(join(agent, "settings.json"), settings("one"));
  if (policy === "scope") {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["test/two"] }));
  }
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: "fake",
    models: ["one", "two"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 16000,
      maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  const { preflight, resolveModel } = await import("../dist/pi/models.js");
  registry = await import("../dist/registry.js");
  assert.deepEqual((await preflight(dir)).usable, ["test/two"]);
  const rejected = policy === "allow" ? /MODEL_ALLOWLIST/ : policy === "deny" ? /MODEL_DENYLIST/ : /out of scope/;
  await assert.rejects(() => resolveModel("test/one", dir), rejected);
  await assert.rejects(() => registry.launch({ cwd: dir, id: "blocked-default", prompt: "Reply OK", tools: [] }), rejected);
  assert.equal(registry.count(), 0, "default rejection releases the session reservation");
  assert.equal(requests, 0, "a blocked default must fail before any model request");

  await writeFile(join(agent, "settings.json"), settings("two"));
  const worker = await registry.launch({ cwd: dir, id: "allowed-default", prompt: "Reply OK", tools: [] });
  await worker.run;
  assert.equal(worker.model, "test/two");
  assert.equal(worker.state, "done");
  assert.equal(requests, 1);
  console.log(`  OK -> SDK default obeys ${policy} policy before a model request; valid default still runs`);
} finally {
  if (registry) for (const worker of registry.all()) { worker.dispose(); await registry.forget(worker.id); }
  http.closeAllConnections();
  await new Promise(resolve => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
