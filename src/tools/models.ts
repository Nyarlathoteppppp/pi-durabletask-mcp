import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LIST_CAP, MODEL_ALLOWLIST, MODEL_DENYLIST } from "../config.js";
import { defaultModelRef, modelScope, resolveModel, usableModels } from "../pi/models.js";
import { json } from "./shared.js";

export function registerModels(server: McpServer): void {
  server.registerTool(
    "models",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "List models this delegate may use from pi's available providers after model filters. " +
        "Use `filter` to find a provider or model, and `offset`/`limit` to page through long lists. " +
        "thinkingLevels lists the levels each returned reasoning model accepts; a model absent from it accepts only off.",
      inputSchema: {
        filter: z.string().optional(),
        cwd: z.string().optional().describe("Picks up a project-local pi model scope"),
        offset: z.number().int().min(0).optional().describe("First matching model index to return"),
        limit: z.number().int().min(1).max(200).optional().describe(`Page size, default ${LIST_CAP}, at most 200`),
      },
    },
    async ({ filter, cwd, offset = 0, limit = LIST_CAP }) => {
      // Same view as spawn: providers whose credentials fail are left out.
      const { models: usable, failing } = await usableModels(cwd);
      const all = usable.map((m) => m.ref);
      const hits = filter ? all.filter((s) => s.toLowerCase().includes(filter.toLowerCase())) : all;
      const models = hits.slice(offset, offset + limit);
      const page = new Set(models);
      const thinkingLevels = Object.fromEntries(usable
        .filter((m) => page.has(m.ref) && m.thinkingLevels.join() !== "off")
        .map((m) => [m.ref, m.thinkingLevels]));
      // Resolve the default the way spawn does, so a short id like "grok-4.7" is compared as provider/id.
      const fallback = defaultModelRef(cwd);
      const resolved = fallback ? await resolveModel(fallback, cwd).catch(() => undefined) : undefined;
      const canonical = resolved ? `${resolved.provider}/${resolved.id}` : fallback;
      return json({
        // What a spawn without `model` uses, and whether this server would allow it.
        defaultModel: canonical ?? "(none configured)",
        ...(canonical ? { defaultUsable: all.includes(canonical) } : {}),
        ...(Object.keys(failing).length ? { failingProviders: failing } : {}),
        count: hits.length,
        offset,
        nextOffset: offset + models.length < hits.length ? offset + models.length : null,
        ...(offset + models.length < hits.length
          ? { note: "More models match. Narrow with filter, or pass offset: nextOffset for the next page." } : {}),
        scoped: Boolean(modelScope(cwd)) || MODEL_ALLOWLIST.size > 0 || MODEL_DENYLIST.size > 0,
        models,
        ...(Object.keys(thinkingLevels).length ? { thinkingLevels } : {}),
      });
    },
  );
}
