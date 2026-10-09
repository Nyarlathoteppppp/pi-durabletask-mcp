import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  type FileEntry,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DIR } from "../config.js";
import type { Checkpoint } from "../durable.js";
import { secretPathGuard } from "../secrets.js";
import type { PiThinkingLevel } from "../types.js";
import { nativeMcpFactories } from "./native-mcp.js";
import { repairEntries } from "./repair.js";
import type { PreparedResources } from "./resources.js";
import { getRuntime, type PiModel } from "./runtime.js";
import { createProtectedGrepTool } from "./search.js";

/** What a delegate's Pi session is built from. The worker owns everything after creation. */
export interface SessionSpec {
  cwd: string;
  tools: string[];
  extensions: boolean;
  nativeMcp: boolean;
  mcpServers: string[];
  /** Explicitly selected resources; absent, skills and context files stay off. */
  resources: PreparedResources | undefined;
  customTools: ToolDefinition[];
  /** Journals the nested calls of tools that run other tools. */
  journal: InlineExtension | undefined;
}

export async function loadResources(spec: SessionSpec): Promise<DefaultResourceLoader> {
  const { cwd, tools, nativeMcp, resources } = spec;
  // Third-party pi extensions start timers and sockets that outlive dispose() and then
  // throw against a stale ctx. A delegate does not need them.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: AGENT_DIR,
    noExtensions: !spec.extensions,
    noSkills: true,
    noContextFiles: true,
    ...(resources ? {
      skillsOverride: () => ({ skills: resources.skills, diagnostics: [] }),
      agentsFilesOverride: () => ({ agentsFiles: resources.agentsFiles }),
    } : {}),
    extensionFactories: [secretPathGuard(cwd),
      ...(nativeMcp && tools.length ? nativeMcpFactories(cwd, spec.mcpServers) : []),
      // codemode over the built-in tools, opted into by naming it; its model API stays off.
      ...(!nativeMcp && tools.includes("codemode")
        ? [{ name: "delegate-codemode", factory: createCodemodeExtension({ mode: "on", models: false }) }] : []),
      ...(spec.journal ? [spec.journal] : [])],
  });

  // The loader is lazy: getExtensions() returns nothing until reload() has run.
  // Always reload so the inline secret-path guard is installed even when third-party
  // extensions stay off. Failure must not leave the secret guard uninstalled.
  await resourceLoader.reload();
  return resourceLoader;
}

export async function createSession(spec: SessionSpec, resourceLoader: DefaultResourceLoader, start: {
  model: PiModel | undefined;
  thinking: PiThinkingLevel | undefined;
  saved: Checkpoint | undefined;
  seedEntries: FileEntry[] | undefined;
}) {
  const { cwd, tools, customTools } = spec;
  const { session } = await createAgentSession({
    cwd,
    modelRuntime: await getRuntime(),
    model: start.model,
    thinkingLevel: start.thinking,
    // Dropping the inherited header lets the SDK create a new identity. Clone entries so
    // compaction or transcript edits in one branch cannot mutate a sibling's history.
    sessionManager: SessionManager.inMemory(cwd, undefined, start.saved ? repairEntries(start.saved)
      : start.seedEntries ? structuredClone(start.seedEntries.filter((entry) => entry.type !== "session")) : undefined),
    tools: [...tools, ...customTools.map((tool) => tool.name)],
    // Pi 1.0.4 keeps MCP tools implicitly when no mcp__ name is selected. Delegates
    // require explicit tool grants, including MCP resource tools without that prefix.
    excludeTools: tools.some((name) => name.startsWith("mcp__")) ? undefined
      : ["mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
        .filter((name) => !tools.includes(name)),
    customTools: [...customTools,
      ...(tools.includes("grep") ? [defineTool(createProtectedGrepTool(cwd))] : [])],
    resourceLoader,
  });
  return session;
}
