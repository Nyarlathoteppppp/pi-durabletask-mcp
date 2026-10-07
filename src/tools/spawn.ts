import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALLOW_ALL,
  BATCH_MAX,
  MAX_DURATION_MS,
  MAX_RETENTION_DAYS,
  MAX_TURNS,
  RETENTION_DAYS,
} from "../config.js";
import { DEFAULT_TOOLS, PERMITTED, READ_ONLY_TOOLS } from "../permissions.js";
import { runExecution, startBatch, startExecution } from "../core.js";
import { json, waitResult } from "./shared.js";
import { coordinatorSchema } from "../coordinator.js";

// Preserve the existing helper import path for consumers.
export { bindCancellation } from "../core.js";

const DURABLE_HELP =
  "Default false: memory only, nothing written, gone when this MCP process exits; right for short, cheap, " +
  "re-runnable work such as reviews, searches and model comparisons. Pass true when the work is long, has " +
  "external side effects, should survive an MCP restart, or needs disk retention. Memory sessions can follow_up while retained in this process.";
const RETENTION_HELP =
  `Durable only: days to keep it on disk after it finishes (default ${RETENTION_DAYS}, max ${MAX_RETENTION_DAYS}). ` +
  "Set it longer when the user wants to come back to this session later.";
const retentionDays = z.number().int().min(1).max(MAX_RETENTION_DAYS).optional();

const ATTACHMENTS_HELP =
  "Absolute paths of text files appended to the prompt, read by this server, e.g. a diff you wrote to your " +
  "scratchpad; they may lie outside cwd. At most 20, 256 KiB each, 1 MiB in total; secret paths are refused.";
const attachments = z.array(z.string()).optional();

const spawnShape = {
  coordinator: coordinatorSchema.optional().describe("Opt-in memory-only codemode orchestration of caller-planned read-only children. Children have independent budgets and count toward server concurrency. Cancelling the coordinator leaves children running; use ordinary abort to stop them."),
  prompt: z.string().describe("The task for the pi agent"),
  forkFrom: z.string().optional().describe("Start a new task from a settled session's history; budgets are fresh. Omitted cwd/model/tools inherit from the parent and are revalidated."),
  attachments: attachments.describe(ATTACHMENTS_HELP),
  saveTo: z.string().optional().describe("Absolute file path: when the run finishes, its final text is written there and results show savedTo instead"),
  model: z.string().optional().describe('Omit for the configured default. Use "provider/modelId" from the models tool to choose another.'),
  thinking: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Explicit pi thinking level. Omit to use pi's configured/default level."),
  cwd: z.string().optional().describe("Absolute working directory. Required unless forkFrom supplies the parent cwd."),
  id: z
    .string()
    .optional()
    .describe(
      'Your own session id for traceability, e.g. "search-audit-01". 1-64 chars of [A-Za-z0-9._:-], ' +
        "must start alphanumeric, must not already be in use. Defaults to a UUID.",
    ),
  label: z.string().optional().describe("Free-text note shown in `sessions`, e.g. what this delegate is for"),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      `Tool allowlist for this delegate. Omit for ${(DEFAULT_TOOLS.length ? DEFAULT_TOOLS : READ_ONLY_TOOLS).join(", ")}; [] disables all tools. ` +
        `Permitted on this server: ${ALLOW_ALL ? "any" : [...PERMITTED].join(", ")}.`,
    ),
  nativeMcp: z.boolean().optional().describe("Enable Pi native MCP independently of third-party extensions. Requires explicit mcpServers and authorized exact tool names, including codemode/tool_search if used."),
  mcpServers: z.array(z.string()).optional().describe("Names from Pi mcp.json to connect. Required with nativeMcp; other servers are not loaded."),
  extensions: z
    .boolean()
    .optional()
    .describe("Load pi extensions for this delegate. Off by default; they add startup cost and can misbehave."),
  durable: z
    .boolean()
    .optional()
    .describe(DURABLE_HELP),
  retentionDays: retentionDays.describe(RETENTION_HELP),
  maxTurns: z
    .number()
    .int()
    .min(1)
    .max(MAX_TURNS)
    .optional()
    .describe(`Maximum model/tool turns for the whole session, cumulative across follow_up; server ceiling ${MAX_TURNS}.`),
  maxDurationMs: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_DURATION_MS)
    .optional()
    .describe(`Wall-clock deadline in milliseconds; server ceiling ${MAX_DURATION_MS}.`),
  maxToolCalls: z.number().int().min(1).max(1000).optional()
    .describe("Cap on the delegate's own tool calls, cumulative across follow_up; it is told its count near the cap, then must answer. Omit for no cap."),
};

const taskShape = z.object({
  coordinator: spawnShape.coordinator,
  prompt: z.string().describe("The task for this delegate"),
  forkFrom: z.string().optional().describe("Overrides the batch forkFrom for this task"),
  attachments: attachments.describe("Overrides the batch `attachments` for this task alone; [] attaches nothing"),
  id: z.string().optional().describe("Session id for this task. Defaults to `idPrefix`-NN, or a UUID."),
  label: z.string().optional().describe("Free-text note for this task"),
  model: z.string().optional().describe("Overrides the batch `model` for this task alone"),
  thinking: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Overrides the batch `thinking` for this task alone"),
  cwd: z.string().optional().describe("Overrides the batch `cwd` for this task alone"),
  tools: z.array(z.string()).optional().describe("Overrides the batch `tools` for this task alone"),
  extensions: z.boolean().optional(),
  durable: z.boolean().optional().describe("Overrides the batch `durable` for this task alone"),
  nativeMcp: z.boolean().optional(),
  mcpServers: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).max(MAX_TURNS).optional(),
  maxDurationMs: z.number().int().min(1_000).max(MAX_DURATION_MS).optional(),
  maxToolCalls: z.number().int().min(1).max(1000).optional().describe("Overrides the batch `maxToolCalls` for this task alone"),
  retentionDays: retentionDays.describe("Overrides the batch `retentionDays` for this task alone"),
});

export function registerSpawn(server: McpServer): void {
  server.registerTool(
    "spawn",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        "Delegate a task to a pi agent running in the background. Returns a sessionId immediately, so " +
        "nothing blocks. Use `wait` for progress/results, `status` for a snapshot, `steer` to redirect, and `answer` for questions. " +
        "Use this for anything that might take more than a minute.",
      inputSchema: spawnShape,
    },
    async (args) => json({ ...await startExecution(args), nextAction: "wait" }),
  );

  server.registerTool(
    "spawn_batch",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        "Fan out several delegates in one call. Each task inherits the batch-level model, cwd, tools " +
        "and extensions unless it overrides them. The whole batch is validated before any delegate " +
        "starts, so a bad model name or a duplicate id fails everything instead of leaving half a " +
        "fan-out running. Wait for the batch with `wait` and the returned sessionIds, rather than " +
        "polling `sessions` or one `status` per delegate.",
      inputSchema: {
        tasks: z.array(taskShape).min(1).max(BATCH_MAX).describe(`1 to ${BATCH_MAX} delegates to start`),
        coordinator: spawnShape.coordinator,
        forkFrom: z.string().optional().describe("Default settled parent session for this batch"),
        attachments: attachments.describe(`Default for every task in this batch. ${ATTACHMENTS_HELP}`),
        saveDir: z.string().optional().describe("Absolute directory: each finished task's final text is written to <sessionId>.md there"),
        model: z.string().optional().describe("Default model for every task in this batch"),
        thinking: z
          .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("Default thinking level for every task in this batch; omit to use pi settings"),
        cwd: z.string().optional().describe("Default working directory for every task in this batch"),
        tools: z.array(z.string()).optional().describe("Default tool allowlist for every task in this batch"),
        extensions: z.boolean().optional().describe("Default extensions setting for every task in this batch"),
        durable: z.boolean().optional().describe(`Default for every task in this batch. ${DURABLE_HELP}`),
        nativeMcp: z.boolean().optional().describe("Default native MCP setting for this batch"),
        mcpServers: z.array(z.string()).optional().describe("Default native MCP server selection for this batch"),
        maxTurns: z
          .number()
          .int()
          .min(1)
          .max(MAX_TURNS)
          .optional()
          .describe(`Default turn budget; server ceiling ${MAX_TURNS}`),
        maxDurationMs: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_DURATION_MS)
          .optional()
          .describe(`Default wall-clock deadline; server ceiling ${MAX_DURATION_MS} ms`),
        maxToolCalls: z.number().int().min(1).max(1000).optional().describe("Default cap on each delegate's own tool calls"),
        retentionDays: retentionDays.describe(`Default for every task in this batch. ${RETENTION_HELP}`),
        idPrefix: z
          .string()
          .optional()
          .describe('Names the tasks `<prefix>-01`, `<prefix>-02`, ... e.g. "audit" gives "audit-01"'),
      },
    },
    async (args) => {
      const result = await startBatch(args);
      const sessions = result.sessions.map((s) => ({ ...s, nextAction: "wait" }));
      return json({
        ...result, sessions, nextAction: sessions.length ? "wait" : "finish",
        next: "Call wait with these sessionIds, until \"settled\"; repeat on continueIds.",
      });
    },
  );

  server.registerTool(
    "run",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        "Delegate a task to a pi agent and wait for the final answer. Blocks until done. " +
        "Client request cancellation aborts the delegate. Prefer spawn plus wait for long work; " +
        "this is for quick questions. Returns a compact result; use verbose: true for the full snapshot.",
      inputSchema: {
        ...spawnShape,
        verbose: z.boolean().optional().describe("Include configuration and the full tool trace with ids and results"),
      },
    },
    async ({ verbose, ...args }, extra) => {
      // Progress notifications reset the MCP request timeout, which defaults to 60s.
      const token = extra?._meta?.progressToken;
      return json(waitResult(await runExecution(args, {
        signal: extra.signal,
        verbose,
        onProgress: token ? async ({ state, turns }) => {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: turns, message: `${state}, turn ${turns}` },
          });
        } : undefined,
      }), verbose));
    },
  );
}
