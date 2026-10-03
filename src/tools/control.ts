import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HISTORY_LIMIT } from "../config.js";
import {
  cancelExecution, followUp, forgetSession, getState, listSessions, resolveInteraction,
  steerExecution, waitForState,
} from "../core.js";
import { json } from "./shared.js";

// Preserve the existing helper import path for consumers.
export { waitForProgress } from "../core.js";

export function registerControl(server: McpServer): void {
  server.registerTool(
    "status",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Check a background pi session. Returns state, turn count, tools used, latest text, and any " +
        "pending questions the agent is waiting on. A non-empty `questions` array means it is blocked " +
        "until you call `answer`. `toolCalls` holds the last 5 calls with shortened arguments and " +
        "`toolCallCount` the total; pass `verbose: true` for every call with ids and results. " +
        "Notices include Pi's automatic provider retries.",
      inputSchema: {
        sessionId: z.string(),
        verbose: z.boolean().optional().describe("Include tool results and call ids in the trace"),
      },
    },
    async ({ sessionId, verbose }) => json(await getState(sessionId, verbose)),
  );

  server.registerTool(
    "steer",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        "Redirect a running pi agent mid-task. The message lands after its current tool call finishes, " +
        "before the next model call. Use this instead of aborting when the agent is going the wrong way.",
      inputSchema: { sessionId: z.string(), message: z.string() },
    },
    async ({ sessionId, message }) => json(await steerExecution(sessionId, message)),
  );

  server.registerTool(
    "wait",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Wait briefly for a background delegate to finish or make observable progress. Returns a " +
        "fresh status snapshot after a new turn/tool call, pending question, terminal state, or timeout. " +
        "Pass prior turns/toolCallCount as afterTurns/afterToolCalls. Answer questions before waiting again. " +
        "Cancelling this wait leaves the delegate running; use `abort` to stop it.",
      inputSchema: {
        sessionId: z.string(),
        timeoutMs: z.number().int().min(250).max(55_000).optional().describe("Default 30000; max 55000"),
        afterTurns: z.number().int().min(0).optional().describe("Prior snapshot's turn count"),
        afterToolCalls: z.number().int().min(0).optional().describe("Prior snapshot's `toolCallCount`"),
        verbose: z.boolean().optional().describe("Include tool results and call ids in the returned trace"),
      },
    },
    async ({ sessionId, ...options }, extra) => json(await waitForState(sessionId, { ...options, signal: extra.signal })),
  );

  server.registerTool(
    "answer",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        "Answer a pending Pi extension UI question. Get requestId from questions[].id in status or wait. " +
        "The delegate is blocked until you answer; answer only actual pending questions.",
      inputSchema: {
        sessionId: z.string(),
        requestId: z.string(),
        value: z.union([z.string(), z.boolean()]).describe("Chosen option, text, or boolean for a confirm"),
      },
    },
    async ({ sessionId, requestId, value }) => json(await resolveInteraction(sessionId, requestId, value)),
  );

  server.registerTool(
    "follow_up",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        "Send another prompt to a delegate that has already finished, keeping everything it read " +
        "and said. Turns are cumulative: follow_up is refused once maxTurns is used up. The " +
        "wall-clock limit applies to each run. Memory sessions can continue while retained here; " +
        "durable sessions can continue after reconnecting while retained on disk. " +
        "For a live session, use `steer`.",
      inputSchema: {
        sessionId: z.string(),
        prompt: z.string().describe("The next turn for this delegate"),
      },
    },
    async ({ sessionId, prompt }) => json(await followUp(sessionId, prompt)),
  );

  server.registerTool(
    "abort",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "Stop a running pi session. Partial output stays readable via `status`.",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => json(await cancelExecution(sessionId)),
  );

  server.registerTool(
    "sessions",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "List pi sessions held by this server, running and finished, plus finished durable sessions " +
        `stored on disk (\`stored\`). Up to ${HISTORY_LIMIT} finished sessions stay loaded; status/wait read ` +
        "stored results without loading, and follow_up loads the conversation. Stored sessions expire by retention.",
      inputSchema: {
        state: z.string().optional().describe("Filter by state: starting, running, done, aborted, error"),
        verbose: z.boolean().optional().describe("Include full text and tool calls"),
      },
    },
    async ({ state, verbose }) => json(listSessions(state, verbose)),
  );

  server.registerTool(
    "forget",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description: "Drop a finished session from the review history, freeing its id for reuse.",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => json(await forgetSession(sessionId)),
  );
}
