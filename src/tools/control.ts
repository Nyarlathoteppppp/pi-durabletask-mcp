import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HISTORY_LIMIT } from "../config.js";
import { all, assertCapacity, forget, resolve } from "../registry.js";
import { storedJobs } from "../durable.js";
import type { PiWorker } from "../pi/worker.js";
import type { Snapshot } from "../types.js";
import { gated, json } from "./shared.js";

const TERMINAL = new Set(["done", "aborted", "error"]);

/** Wait without owning the worker lifecycle. Cancelling this wait never aborts the delegate. */
export async function waitForProgress(
  worker: PiWorker,
  timeoutMs: number,
  signal?: AbortSignal,
  afterTurns = worker.turns,
  afterToolCalls = worker.toolCalls.length,
): Promise<Snapshot> {
  if (
    TERMINAL.has(worker.state) ||
    worker.turns > afterTurns ||
    worker.toolCalls.length > afterToolCalls ||
    signal?.aborted
  )
    return worker.snapshot();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve(worker.snapshot());
    };
    const poll = setInterval(() => {
      if (
        TERMINAL.has(worker.state) ||
        worker.turns > afterTurns ||
        worker.toolCalls.length > afterToolCalls
      )
        finish();
    }, 200);
    const timeout = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

export function registerControl(server: McpServer): void {
  gated(
    server,
    "status",
    {
      description:
        "Check a background pi session. Returns state, turn count, tools used, latest text, and any " +
        "pending questions the agent is waiting on. A non-empty `questions` array means it is blocked " +
        "until you call `answer`. `toolCalls` traces every tool the delegate ran, in order.",
      inputSchema: {
        sessionId: z.string(),
        verbose: z.boolean().optional().describe("Include tool results and call ids in the trace"),
      },
    },
    async ({ sessionId, verbose }) => json((await resolve(sessionId)).snapshot({ verbose })),
  );

  gated(
    server,
    "steer",
    {
      description:
        "Redirect a running pi agent mid-task. The message lands after its current tool call finishes, " +
        "before the next model call. Use this instead of aborting when the agent is going the wrong way.",
      inputSchema: { sessionId: z.string(), message: z.string() },
    },
    async ({ sessionId, message }) => json(await (await resolve(sessionId)).steer(message)),
  );

  gated(
    server,
    "wait",
    {
      description:
        "Wait briefly for a background delegate to finish or make observable progress. Returns a " +
        "fresh status snapshot after a new turn/tool call, terminal state, or timeout. Cancelling " +
        "this wait does not abort the delegate; use `abort` explicitly for that.",
      inputSchema: {
        sessionId: z.string(),
        timeoutMs: z.number().int().min(250).max(55_000).optional().describe("Default 30000; max 55000"),
        afterTurns: z.number().int().min(0).optional().describe("Prior snapshot's turn count"),
        afterToolCalls: z.number().int().min(0).optional().describe("Prior snapshot's tool-call count"),
        verbose: z.boolean().optional().describe("Include tool results and call ids in the returned trace"),
      },
    },
    async ({ sessionId, timeoutMs = 30_000, afterTurns, afterToolCalls, verbose }, extra) => {
      const worker = await resolve(sessionId);
      await waitForProgress(
        worker,
        timeoutMs,
        extra.signal,
        afterTurns ?? worker.turns,
        afterToolCalls ?? worker.toolCalls.length,
      );
      return json(worker.snapshot({ verbose }));
    },
  );

  gated(
    server,
    "answer",
    {
      description:
        "Answer a question raised by a pi agent. Get `requestId` from `status`. Only pi extensions " +
        "can ask, so questions appear only for delegates spawned with `extensions: true`; the " +
        "MCP adapter's tool-approval and elicitation prompts are the usual source. A delegate " +
        "waiting on one is blocked until you answer it.",
      inputSchema: {
        sessionId: z.string(),
        requestId: z.string(),
        value: z.union([z.string(), z.boolean()]).describe("Chosen option, text, or boolean for a confirm"),
      },
    },
    async ({ sessionId, requestId, value }) => json((await resolve(sessionId)).answer(requestId, value)),
  );

  gated(
    server,
    "follow_up",
    {
      description:
        "Send another prompt to a delegate that has already finished, keeping everything it read " +
        "and said. Turns and wall-clock already spent still count toward the original budget; " +
        "follow_up is refused once that budget is exhausted. For a live session, use `steer`.",
      inputSchema: {
        sessionId: z.string(),
        prompt: z.string().describe("The next turn for this delegate"),
      },
    },
    async ({ sessionId, prompt }) => {
      const worker = await resolve(sessionId);
      // Let the worker produce the more useful "use steer" error for a live session.
      if (!worker.isActive) assertCapacity();
      return json(await worker.followUp(prompt));
    },
  );

  gated(
    server,
    "abort",
    {
      description: "Stop a running pi session. Partial output stays readable via `status`.",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => json(await (await resolve(sessionId)).abort()),
  );

  gated(
    server,
    "sessions",
    {
      description:
        "List pi sessions held by this server, running and finished, plus finished durable sessions " +
        `stored on disk (\`stored\`). Up to ${HISTORY_LIMIT} finished sessions stay loaded; stored ones load ` +
        "on first use by id. Stored sessions are deleted after the retention period.",
      inputSchema: {
        state: z.string().optional().describe("Filter by state: starting, running, done, aborted, error"),
        verbose: z.boolean().optional().describe("Include full text and tool calls"),
      },
    },
    async ({ state, verbose }) => {
      const snaps = all().map((w) => w.snapshot());
      const filtered = state ? snaps.filter((s) => s.state === state) : snaps;
      const list = verbose
        ? filtered
        : filtered.map((s) => ({
            sessionId: s.sessionId,
            label: s.label,
            state: s.state,
            model: s.model,
            thinking: s.thinking,
            turns: s.turns,
            elapsedMs: s.elapsedMs,
            limits: s.limits,
            termination: s.termination,
            startedAt: s.startedAt,
            finishedAt: s.finishedAt,
            pendingQuestions: s.questions.length,
            durable: s.durable,
          }));
      const loaded = new Set(snaps.map((s) => s.sessionId));
      const stored = storedJobs().filter((job) => !loaded.has(job.sessionId));
      return json({ count: list.length, sessions: list, stored });
    },
  );

  gated(
    server,
    "forget",
    {
      description: "Drop a finished session from the review history, freeing its id for reuse.",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const w = all().find((worker) => worker.id === sessionId);
      if (w?.isActive)
        throw new Error(`Session ${sessionId} is still ${w.state}. Call abort first.`);
      w?.dispose();
      await forget(sessionId);
      return json({ forgotten: sessionId });
    },
  );
}
