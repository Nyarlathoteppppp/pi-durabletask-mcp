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

/** Pi's resource tools read the selected servers' resources; they carry no server prefix. */
const RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

/**
 * A native selection must grant something from its servers; otherwise the delegate silently runs
 * without them. `tools` is the effective list, after defaults. codemode and tool_search reach only
 * the MCP tools named there, so they do not count. Request time only: stored jobs are not re-checked.
 */
export function assertNativeMcpGrant(options: NativeMcpOptions, tools: string[]): void {
  if (!options.nativeMcp || !tools.length) return;
  const servers = options.mcpServers ?? [];
  // Pi's naming: mcp__<server>__<tool>, non-identifier characters as "_"; a name over 64 characters
  // keeps its first 55 and gets a hash suffix.
  const prefixes = servers.map((server) => `mcp__${server}__`.replace(/[^A-Za-z0-9_]/g, "_"));
  if (tools.some((tool) => RESOURCE_TOOLS.has(tool) || prefixes.some((prefix) => tool.startsWith(prefix.slice(0, 55))))) return;
  throw new Error(`nativeMcp grants no tool from mcpServers [${servers.join(", ")}] (tools: ${tools.join(", ")}): ` +
    `add exact names such as ${prefixes[0]}<tool> to tools (and PI_DELEGATE_ALLOW_TOOLS); codemode and tool_search ` +
    "reach only named tools. Pass tools: [] for a tool-free run.");
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
