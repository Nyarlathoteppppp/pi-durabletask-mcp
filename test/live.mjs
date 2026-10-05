import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Explicitly opt in: this script contacts the selected provider and may consume quota.
const model = process.env.PI_DELEGATE_MODEL;
assert.ok(model, "Set PI_DELEGATE_MODEL to the exact provider/model to smoke-test.");
const c = new Client({ name: "live-smoke", version: "1" });
try {
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: process.env }));
  const call = async (name, args) => {
    const r = await c.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content?.[0]?.text);
    return JSON.parse(r.content[0].text);
  };
  await call("init", { cwd: process.cwd() });
  const result = await call("run", { cwd: process.cwd(), model, tools: [], maxTurns: 1, verbose: true,
    prompt: "Do not call tools. Reply with exactly OK." });
  assert.equal(result.state, "done", result.error);
  assert.equal(result.model, model);
  assert.equal(result.lastText.trim(), "OK");
  assert.deepEqual(result.activeTools, []);
  await call("forget", { sessionId: result.sessionId });
  console.log(`  OK -> ${model}, no tools, ${result.elapsedMs}ms`);
} finally { await c.close(); }
