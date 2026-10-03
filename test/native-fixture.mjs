import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const directory = process.argv[2];
const server = new McpServer({ name: "native-recovery-fixture", version: "1" });
appendFileSync(`${directory}/connections.txt`, `${process.pid}\n`);
server.registerTool("effect", { inputSchema: { mode: z.string() } }, async ({ mode }) => {
  appendFileSync(`${directory}/effects.txt`, `${mode}\n`);
  if (mode === "unknown") await new Promise(() => {});
  return { content: [{ type: "text", text: "COMMITTED_NATIVE_RESULT" }] };
});
server.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
process.stdin.on("close", () => process.exit(0));
await server.connect(new StdioServerTransport());
