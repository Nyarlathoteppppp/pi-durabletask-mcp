import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The fake model never answers, so a wait returns only when its timeout ends.
const dir = await mkdtemp(join(tmpdir(), "pi-wait-default-"));
const http = createServer((req, res) => { req.resume(); res.writeHead(200, { "Content-Type": "text/event-stream" }); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
    PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_STALL_MS: "0", PI_DELEGATE_WAIT_MAX_MS: "1500" });
  const core = await import("../dist/core.js");
  const { sessionId } = await core.startExecution({ cwd: dir, tools: [], prompt: "never answered" });

  // A wait for the result, given no timeout, waits as long as this server allows instead of a fixed 30 s,
  // so callers on hosts that allow long waits do not poll.
  const elapsed = async (wait) => { const at = Date.now(); await wait; return Date.now() - at; };
  const many = await elapsed(core.waitForMany([sessionId], { until: "all_settled" }));
  assert.ok(many >= 1400 && many < 10_000, `waitForMany took ${many} ms`);
  const one = await elapsed(core.waitForState(sessionId, { until: "settled" }));
  assert.ok(one >= 1400 && one < 10_000, `waitForState took ${one} ms`);
  // A progress wait keeps its short default, never above the server's limit.
  const progress = await elapsed(core.waitForState(sessionId, {}));
  assert.ok(progress >= 1400 && progress < 10_000, `progress wait took ${progress} ms`);
  await core.cancelExecution(sessionId);
  console.log("  OK -> waits for a result default to the server's longest wait; progress waits stay short");
} finally {
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
process.exit(0);
