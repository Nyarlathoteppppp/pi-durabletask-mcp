/** Explicit resource selection; no global discovery and no additional tool grants. */
import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { readTextFiles } from "../attachments.js";
import { AGENT_DIR } from "../config.js";

export const resourcesSchema = z.object({
  contextFiles: z.array(z.string()).optional().describe("Absolute UTF-8 instruction files injected as project context; only these files are selected."),
  skills: z.array(z.string()).optional().describe("Absolute skill markdown files (e.g. /repo/.pi/skills/review/SKILL.md). Requires read or bash among granted tools; only these skills are advertised, with bodies loaded on demand."),
}).strict();
export type ResourceSelection = z.infer<typeof resourcesSchema>;
export interface PreparedResources {
  agentsFiles: Array<{ path: string; content: string }>;
  skills: Skill[];
}

export async function prepareResources(selection: ResourceSelection | undefined, cwd: string, tools: string[]): Promise<PreparedResources> {
  const { contextFiles = [], skills: paths = [] } = selection ?? {};
  if (paths.length && !tools.some((name) => name === "read" || name === "bash"))
    throw new Error("resources.skills requires an explicitly granted read or bash tool to load skill bodies.");
  // Read all selected files together so the existing attachment total applies to resources too.
  const files = await readTextFiles([...contextFiles, ...paths], "resources");
  const skillFiles = files.slice(contextFiles.length);
  const loaded = paths.length ? loadSkills({ cwd, agentDir: AGENT_DIR,
    skillPaths: skillFiles.map((f) => f.resolvedPath), includeDefaults: false }) : { skills: [], diagnostics: [] };
  for (const file of skillFiles) {
    if (!loaded.skills.some((skill) => skill.filePath === file.resolvedPath)) {
      const diagnostic = loaded.diagnostics.find((d) => d.path === file.resolvedPath);
      throw new Error(`resources.skills: cannot load ${file.path}${diagnostic ? `: ${diagnostic.message}` : ""}`);
    }
  }
  return { agentsFiles: files.slice(0, contextFiles.length).map(({ path, content }) => ({ path, content })), skills: loaded.skills };
}
