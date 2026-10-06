import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  ProjectTrustStore, type InlineExtension, type LoadedMcpConfig, type McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DIR } from "../config.js";

export interface NativeMcpOptions {
  nativeMcp?: boolean;
  mcpServers?: string[];
}

type McpProjectOverride = Partial<Pick<McpServerConfig, "enabled" | "exposure" | "toolExposure">>;

/** Selection is explicit: the user's global config also includes this bridge itself. */
export function validateNativeMcp(options: NativeMcpOptions, cwd: string): void {
  if (!options.nativeMcp) {
    if (options.mcpServers?.length) throw new Error("mcpServers requires nativeMcp: true.");
    return;
  }
  if (!options.mcpServers?.length) throw new Error("nativeMcp requires an explicit, non-empty mcpServers list.");
  selectedConfig(cwd, options.mcpServers, new ProjectTrustStore(AGENT_DIR).get(cwd) === true);
}

function selectedConfig(cwd: string, names: string[], projectTrusted: boolean): LoadedMcpConfig {
  const servers = new Map<string, LoadedMcpConfig["servers"][number] & { override?: string }>();
  const paths = [{ path: join(AGENT_DIR, "mcp.json"), scope: "global" as const },
    ...(projectTrusted ? [{ path: join(cwd, ".pi", "mcp.json"), scope: "project" as const }] : [])];
  for (const { path, scope } of paths) {
    if (!existsSync(path)) continue;
    const config = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
    for (const name of names) {
      const entry = config.mcpServers?.[name];
      if (entry) {
        // Pi 1.0.1 permits project overrides of exposure/enabled without redefining transport.
        if (scope === "project" && !("command" in entry) && !("url" in entry) && !("type" in entry)) {
          const base = servers.get(name);
          if (!base) throw new Error(`MCP server ${name}: a project override requires a global server.`);
          if (Object.keys(entry).some((key) => !["enabled", "exposure", "toolExposure"].includes(key)))
            throw new Error(`MCP server ${name}: a project override can only set enabled, exposure and toolExposure.`);
          // Keep the global scope: inherited auth.provider is still a global credential.
          servers.set(name, { ...base, config: { ...base.config, ...(entry as McpProjectOverride) }, override: path });
          continue;
        }
        // Match Pi's credential boundary: a project cannot redirect a provider token.
        if (scope === "project" && "url" in entry && entry.auth)
          throw new Error(`MCP server ${name}: auth.provider is only allowed in global mcp.json.`);
        servers.set(name, { name, config: entry, source: path, scope });
      }
    }
  }
  for (const name of names) {
    const entry = servers.get(name);
    if (!entry) throw new Error(`MCP server ${name} is not configured in the Pi agent directory or trusted project.`);
    if (entry.config.enabled === false) throw new Error(`MCP server ${name} is disabled in ${entry.override ?? entry.source}.`);
  }
  return { servers: [...servers.values()], autoEnableCodemode: false, errors: [] };
}

export function nativeMcpFactories(cwd: string, names: string[]): InlineExtension[] {
  return [
    { name: "delegate-codemode", factory: createCodemodeExtension({ mode: "on", models: false }) },
    { name: "delegate-tool-search", factory: createToolSearchExtension() },
    { name: "delegate-mcp", factory: createMcpExtension({
      loadConfig: (ctx) => selectedConfig(cwd, names, ctx.isProjectTrusted()),
    }) },
  ];
}
