import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PKG_NAME, PKG_VERSION } from "./config.js";
import { registerTools } from "./tools/index.js";

export function createServer(): McpServer {
  // Embedders own startup recovery; the stdio entry point runs it before connecting.
  const server = new McpServer(
    { name: PKG_NAME, version: PKG_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Delegate to Pi with spawn and an absolute repo cwd. Omit model/tools for the configured model/read-only tools. " +
        "After successful spawn/spawn_batch/run/follow_up, show one line per started run: <work type> · <model> · <thinking>. " +
        "Use the user's language and task for work type; use returned model/thinking, not requested defaults. " +
        "For batches, report each started session. Say not reported for absent fields. Do not repeat on status/wait. " +
        "To get a result, loop wait with until:\"settled\"; for a batch, wait with sessionIds. Answer pending questions. " +
        "Steer running work; follow_up finished work while retained. Memory sessions live in this server; " +
        "durable:true saves across restarts. Use models to choose a model; init is optional setup diagnostics. " +
        "Cancelling run stops its delegate; cancelling wait only ends the wait. " +
        "Handing over to another window: handoff save; picking up: handoff read, then follow its resumeHint.",
    },
  );
  registerTools(server);
  return server;
}
