import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HISTORY_LIMIT, MAX_TURNS } from "../config.js";
import {
  cancelExecution, followUp, forgetSession, getState, listSessions, resolveInteraction,
  steerExecution, waitForMany, waitForState,
} from "../core.js";
import { batchNextAction, json, waitResult, withNextAction } from "./shared.js";
import { resolveDelegateCwd } from "../workspace.js";

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
        "Notices cover this run; verbose preserves their full history. Teams with saveDir expose reportIndex and publication errors. remainingTurns/canFollowUp report state and turn-budget " +
        "readiness; ownership, capacity and auth are checked by follow_up.",
      inputSchema: {
        sessionId: z.string(),
        verbose: z.boolean().optional().describe("Include the full tool trace and notice history"),
      },
    },
    async ({ sessionId, verbose }) => json(withNextAction(await getState(sessionId, verbose))),
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
        "Wait for delegates without polling in a loop. until: \"progress\" (default) returns after a new " +
        "turn/tool call, a pending question, the end, or timeout; pass prior turns/toolCallCount as " +
        "afterTurns/afterToolCalls. until: \"settled\" returns only when it finishes or asks a question, " +
        "so loop on it to get the result. With sessionIds (e.g. a spawn_batch), returns when any one settles " +
        "(\"settled\") or all do (\"all_settled\"): settled/pending ids, continueIds (everything not finished, " +
        "including sessions waiting for an answer) and a summary per session, with the final text of finished " +
        "ones and any pending questions. Answer questions, then wait again on continueIds. " +
        "Single-session results omit the tool trace and configuration by default; use verbose: true for the full snapshot and notice history. " +
        "Teams with saveDir expose reportIndex; reportIndexError means its latest publication failed. " +
        "nextAction is wait, answer or finish; finish means this run ended, so check state/error/termination. " +
        "Cancelling this wait leaves delegates running; use `abort` to stop one.",
      inputSchema: {
        sessionId: z.string().optional().describe("One session; returns its status snapshot"),
        sessionIds: z.array(z.string()).min(1).max(50).optional().describe("Several sessions; returns a summary of each"),
        until: z.enum(["progress", "settled", "all_settled"]).optional()
          .describe("Default progress for sessionId, settled for sessionIds"),
        timeoutMs: z.number().int().min(250).max(55_000).optional().describe("Default 30000; max 55000"),
        afterTurns: z.number().int().min(0).optional().describe("Prior snapshot's turn count"),
        afterToolCalls: z.number().int().min(0).optional().describe("Prior snapshot's `toolCallCount`"),
        verbose: z.boolean().optional().describe("Single session: include the full snapshot, tool results and call ids"),
      },
    },
    async ({ sessionId, sessionIds, ...options }, extra) => {
      if ((sessionId === undefined) === (sessionIds === undefined))
        throw new Error("Pass exactly one of sessionId or sessionIds.");
      if (sessionIds) {
        if (options.until === "progress") throw new Error('With sessionIds, until is "settled" or "all_settled".');
        const { timeoutMs, until } = options;
        const result = await waitForMany(sessionIds, { timeoutMs, until, signal: extra.signal });
        const sessions = result.sessions.map((s) => withNextAction(s));
        return json({ ...result, sessions, nextAction: batchNextAction(sessions) });
      }
      return json(waitResult(await waitForState(sessionId!, { ...options, signal: extra.signal }), options.verbose));
    },
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
        "and said. Omit budget fields to use remaining quotas; pass maxTurns/maxToolCalls for fresh " +
        "quotas for this run. Counts and usage remain cumulative. The " +
        "wall-clock limit applies to each run. Memory sessions can continue while retained here; " +
        "durable sessions can continue after reconnecting while retained on disk. " +
        "For a live session, use `steer`.",
      inputSchema: {
        sessionId: z.string(),
        prompt: z.string().describe("The next turn for this delegate"),
        maxTurns: z.number().int().min(1).max(MAX_TURNS).optional().describe("Fresh turn quota for this run; omitted keeps the remaining budget"),
        maxToolCalls: z.number().int().min(1).max(1000).optional().describe("Fresh own-tool-call quota for this run; omitted keeps the remaining budget"),
        attachments: z.array(z.string()).optional().describe("Absolute paths of text files appended to this prompt, as on spawn"),
        saveTo: z.string().optional().describe("Absolute file path for this run's final text, as on spawn"),
      },
    },
    async ({ sessionId, prompt, attachments, saveTo, maxTurns, maxToolCalls }) => json({ ...await followUp(sessionId, prompt, attachments, saveTo, { maxTurns, maxToolCalls }), nextAction: "wait" }),
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
        "stored results without loading, and follow_up loads the conversation. Stored sessions expire by retention. " +
        "Pass cwd to find this project's history; entries include remainingTurns and state/budget canFollowUp.",
      inputSchema: {
        cwd: z.string().optional().describe("Absolute project directory; includes loaded and stored sessions for this cwd"),
        state: z.string().optional().describe("Filter by state: starting, running, done, aborted, error"),
        verbose: z.boolean().optional().describe("Include full text and tool calls"),
      },
    },
    async ({ state, verbose, cwd }) => json(listSessions(state, verbose,
      cwd === undefined ? undefined : await resolveDelegateCwd(cwd))),
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
