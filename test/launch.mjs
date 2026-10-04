import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [cmd, ...args] = process.argv.slice(2);
const c = new Client({ name: "launch", version: "0" });
await c.connect(new StdioClientTransport({ command: cmd, args }));
const { tools } = await c.listTools();
for (const name of ["status", "wait", "sessions", "models"]) {
  if (tools.find(tool => tool.name === name)?.annotations?.readOnlyHint !== true)
    throw new Error(`${name} must advertise read-only behavior`);
}
for (const name of ["spawn", "spawn_batch", "run", "steer", "answer", "follow_up", "abort", "forget"]) {
  const annotations = tools.find(tool => tool.name === name)?.annotations;
  if (annotations?.readOnlyHint !== false || annotations?.destructiveHint !== true)
    throw new Error(`${name} must describe its potential mutations`);
}
const handoff = tools.find((tool) => tool.name === "handoff")?.annotations;
if (handoff?.readOnlyHint !== false || handoff?.destructiveHint !== false)
  throw new Error("handoff writes notes but never changes a session");
if (tools.find(tool => tool.name === "init")?.annotations?.readOnlyHint !== false)
  throw new Error("init may refresh OAuth and must not advertise read-only behavior");
const spawn = tools.find((tool) => tool.name === "spawn");
if (!spawn?.inputSchema?.properties?.thinking)
  throw new Error("spawn schema does not expose the thinking argument");
if (!spawn?.inputSchema?.properties?.maxTurns || !spawn?.inputSchema?.properties?.maxDurationMs)
  throw new Error("spawn schema does not expose worker safety budgets");
if (!tools.some((tool) => tool.name === "wait"))
  throw new Error("server does not expose non-destructive wait");
console.log(`  OK -> ${tools.length} tools: ${tools.map(t=>t.name).join(", ")}`);
await c.close(); process.exit(0);
