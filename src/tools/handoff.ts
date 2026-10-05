import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readHandoff, saveHandoff } from "../handoff.js";
import { json } from "./shared.js";

export function registerHandoff(server: McpServer): void {
  server.registerTool(
    "handoff",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description:
        "Hand a Pi session over between Claude/Codex windows. save (when the user asks to hand over): record " +
        "the repository cwd, the sessionId, and a short goal, completed and next. read (when the user asks to pick " +
        "up a project): returns the latest note for cwd (or the one named), plus resumeHint and howToResume, computed " +
        "from the session's live state. Follow resumeHint, then use status/wait/follow_up as usual. A note is a " +
        "summary, not the session's state; it never claims, recovers or deletes a session. " +
        "remainingTurns/canFollowUp describe state and turn-budget readiness only.",
      inputSchema: {
        action: z.enum(["save", "read"]),
        cwd: z.string().describe("Absolute path of the repository. save: the session's own cwd, exactly as it was spawned with"),
        name: z.string().max(100).optional().describe("Optional label to keep several handoffs per repository; read defaults to the newest"),
        sessionId: z.string().optional().describe("save: the Pi session to hand over"),
        goal: z.string().max(2000).optional().describe("save: what the work is for"),
        completed: z.string().max(4000).optional().describe("save: what is done, including results a new window needs"),
        next: z.string().max(2000).optional().describe("save: the next step"),
      },
    },
    async ({ action, cwd, name, sessionId, goal, completed, next }) => {
      if (action === "read") return json(await readHandoff(cwd, name));
      if (!sessionId || goal === undefined || completed === undefined || next === undefined)
        throw new Error("save needs sessionId, goal, completed and next.");
      return json(await saveHandoff({ cwd, name, sessionId, goal, completed, next }));
    },
  );
}
