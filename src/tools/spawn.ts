import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALLOW_ALL,
  BATCH_MAX,
  DEFAULT_MODEL,
  MAX_DURATION_MS,
  MAX_TURNS,
  PROGRESS_MS,
  RUN_DEFAULT_DURATION_MS,
  RUN_DEFAULT_TURNS,
} from "../config.js";
import { PERMITTED, pickTools, READ_ONLY_TOOLS } from "../permissions.js";
import { assertThinkingSupported, resolveModel } from "../pi/models.js";
import { message } from "../pi/worker.js";
import { claimId, evictHistory, launch, launchBatch } from "../registry.js";
import { resolveDelegateCwd } from "../workspace.js";
import { validateNativeMcp } from "../pi/native-mcp.js";
import { gated, json } from "./shared.js";

export function bindCancellation(
  signal: AbortSignal,
  abort: () => void | Promise<void>,
): () => void {
  const cancel = (): void => {
    void abort();
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

const DURABLE_HELP =
  "Default true: saved to disk, recovered after an MCP restart, kept for follow_up until retention expires. " +
  "false: memory only, nothing written, gone when this MCP process exits. Use false for short, cheap, " +
  "re-runnable work such as reviews, searches and model comparisons.";

const spawnShape = {
  prompt: z.string().describe("The task for the pi agent"),
  model: z.string().optional().describe('Model as "provider/modelId", e.g. "openrouter/stealth/ox-alpha"'),
  thinking: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Explicit pi thinking level. Omit to use pi's configured/default level."),
  cwd: z.string().describe("Absolute working directory for the agent. Required; not the MCP process cwd."),
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
      `Tool allowlist for this delegate. Omit for ${READ_ONLY_TOOLS.join(", ")}; [] disables all tools. ` +
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
  maxTurns: z
    .number()
    .int()
    .min(1)
    .max(MAX_TURNS)
    .optional()
    .describe(`Maximum model/tool turns for this run; server ceiling ${MAX_TURNS}.`),
  maxDurationMs: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_DURATION_MS)
    .optional()
    .describe(`Wall-clock deadline in milliseconds; server ceiling ${MAX_DURATION_MS}.`),
};

const taskShape = z.object({
  prompt: z.string().describe("The task for this delegate"),
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
});

export function registerSpawn(server: McpServer): void {
  gated(
    server,
    "spawn",
    {
      description:
        "Delegate a task to a pi agent running in the background. Returns a sessionId immediately, so " +
        "nothing blocks. Poll with `status`, redirect with `steer`, answer its questions with `answer`. " +
        "Use this for anything that might take more than a minute.",
      inputSchema: spawnShape,
    },
    async (args) => {
      const w = await launch(args);
      return json({
        sessionId: w.id,
        label: w.label,
        state: w.state,
        model: w.model,
        thinking: w.thinking,
        activeTools: w.activeTools,
        limits: { maxTurns: w.maxTurns, maxDurationMs: w.maxDurationMs },
      });
    },
  );

  gated(
    server,
    "spawn_batch",
    {
      description:
        "Fan out several delegates in one call. Each task inherits the batch-level model, cwd, tools " +
        "and extensions unless it overrides them. The whole batch is validated before any delegate " +
        "starts, so a bad model name or a duplicate id fails everything instead of leaving half a " +
        "fan-out running. Poll the result with `sessions`, which reports all of them at once, rather " +
        "than one `status` per delegate.",
      inputSchema: {
        tasks: z.array(taskShape).min(1).max(BATCH_MAX).describe(`1 to ${BATCH_MAX} delegates to start`),
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
        idPrefix: z
          .string()
          .optional()
          .describe('Names the tasks `<prefix>-01`, `<prefix>-02`, ... e.g. "audit" gives "audit-01"'),
      },
    },
    async ({ tasks, model, thinking, cwd, tools, extensions, durable, nativeMcp, mcpServers, maxTurns, maxDurationMs, idPrefix }) => {
      const width = Math.max(String(tasks.length).length, 2);
      const merged = tasks.map((t, i) => ({
        prompt: t.prompt,
        label: t.label,
        model: t.model ?? model,
        thinking: t.thinking ?? thinking,
        cwd: t.cwd ?? cwd,
        tools: t.tools ?? tools,
        extensions: t.extensions ?? extensions,
        durable: t.durable ?? durable,
        nativeMcp: t.nativeMcp ?? nativeMcp,
        mcpServers: t.mcpServers ?? mcpServers,
        maxTurns: t.maxTurns ?? maxTurns,
        maxDurationMs: t.maxDurationMs ?? maxDurationMs,
        id: t.id ?? (idPrefix ? `${idPrefix}-${String(i + 1).padStart(width, "0")}` : undefined),
      }));

      // Validate the batch up front. Every check here is cheap and deterministic, and a
      // half-started fan-out is the worst outcome: you pay for the delegates that launched
      // and still have to work out which ones did not.
      const seen = new Set<string>();
      for (const [i, t] of merged.entries()) {
        if (t.id) {
          if (seen.has(t.id))
            throw new Error(`tasks[${i}] reuses id "${t.id}" from earlier in the same batch. Ids must be unique.`);
          seen.add(t.id);
          claimId(t.id);
        }
        try {
          pickTools(t.tools);
          const taskCwd = await resolveDelegateCwd(t.cwd ?? cwd);
          validateNativeMcp(t, taskCwd);
          const taskModel = await resolveModel(t.model || DEFAULT_MODEL, taskCwd);
          assertThinkingSupported(taskModel, t.thinking);
        } catch (e) {
          throw new Error(`tasks[${i}]${t.id ? ` (${t.id})` : ""}: ${message(e)}`);
        }
      }

      const started: Array<{
        index: number;
        sessionId: string;
        label?: string;
        state: string;
        model?: string;
        thinking?: string;
        limits: { maxTurns: number; maxDurationMs: number };
      }> = [];
      const failures: Array<{ index: number; id?: string; error: string }> = [];
      const results = await launchBatch(merged);
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          const w = result.value;
          started.push({
            index,
            sessionId: w.id,
            label: w.label,
            state: w.state,
            model: w.model,
            thinking: w.thinking,
            limits: { maxTurns: w.maxTurns, maxDurationMs: w.maxDurationMs },
          });
        } else {
          failures.push({ index, id: merged[index]?.id, error: message(result.reason) });
        }
      });
      const byIndex = (a: { index: number }, b: { index: number }) => a.index - b.index;
      started.sort(byIndex);
      failures.sort(byIndex);

      return json({
        requested: merged.length,
        started: started.length,
        sessions: started,
        // Only reachable if a session dies during construction, after validation passed.
        ...(failures.length ? { failed: failures.length, failures } : {}),
        next: "Poll with `sessions` (one call covers the whole batch). `steer` and `abort` stay per session.",
      });
    },
  );

  gated(
    server,
    "run",
    {
      description:
        "Delegate a task to a pi agent and wait for the final answer. Blocks until done. " +
        "Prefer `spawn` for long work; this is for quick questions.",
      inputSchema: spawnShape,
    },
    async (args, extra) => {
      const w = await launch({
        ...args,
        maxTurns: args.maxTurns ?? RUN_DEFAULT_TURNS,
        maxDurationMs: args.maxDurationMs ?? RUN_DEFAULT_DURATION_MS,
      });
      const unbindCancellation = bindCancellation(extra.signal, async () => {
        await w.abort("caller_cancelled");
      });
      // Progress notifications reset the MCP request timeout, which defaults to 60s.
      const token = extra?._meta?.progressToken;
      const ticker = token
        ? setInterval(() => {
            void extra
              ?.sendNotification?.({
                method: "notifications/progress",
                params: { progressToken: token, progress: w.turns, message: `${w.state}, turn ${w.turns}` },
              })
              ?.catch(() => {});
          }, PROGRESS_MS)
        : undefined;
      try {
        await w.run;
      } finally {
        if (ticker) clearInterval(ticker);
        unbindCancellation();
      }
      const snap = w.snapshot();
      evictHistory();
      return json(snap);
    },
  );
}
