import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerControl } from "./control.js";
import { registerInit } from "./init.js";
import { registerModels } from "./models.js";
import { registerSpawn } from "./spawn.js";

/** Tool operations validate their own inputs; init is optional diagnostics. */
export function registerTools(server: McpServer): void {
  registerInit(server);
  registerSpawn(server);
  registerControl(server);
  registerModels(server);
}
