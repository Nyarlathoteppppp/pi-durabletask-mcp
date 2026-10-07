/** Caller-planned, one-level codemode delegation. Lifecycle and admission stay in the core. */
import { defineTool, type ToolDefinition, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { BATCH_MAX, MAX_DURATION_MS, MAX_TURNS } from "./config.js";
import { READ_ONLY_TOOLS } from "./permissions.js";
import type { startBatch, waitForMany, getState } from "./core.js";

const RESEARCH_TOOLS = ["mcp__exa__web_search_exa", "mcp__exa__web_fetch_exa"];

export const coordinatorSchema = z.object({
  tasks: z.array(z.object({
    prompt: z.string(),
    label: z.string().optional(),
    model: z.string().optional(),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    tools: z.array(z.enum(["read", "grep", "find", "ls"])).optional(),
    research: z.boolean().optional().describe("Override the plan's web research setting; enables only configured Exa search/fetch, subject to server tool permissions."),
    forkFrom: z.string().optional(),
    maxTurns: z.number().int().min(1).max(MAX_TURNS).default(Math.min(10, MAX_TURNS)),
    maxToolCalls: z.number().int().min(1).max(1000).default(12),
    maxDurationMs: z.number().int().min(1000).max(MAX_DURATION_MS).default(Math.min(240_000, MAX_DURATION_MS)),
  }).strict()).min(1).max(BATCH_MAX),
  saveDir: z.string().optional(),
  forkFrom: z.string().optional(),
  research: z.boolean().optional().describe("Enable configured Exa search/fetch for children; requires the two exact tools in PI_DELEGATE_ALLOW_TOOLS. Off when omitted."),
}).strict();

export type CoordinatorOptions = z.input<typeof coordinatorSchema>;
type Operations = { startBatch: typeof startBatch; waitForMany: typeof waitForMany; getState: typeof getState };

/** Runtime closures only: neither these definitions nor dispatch membership go into SQLite. */
export function createCoordinatorTools(options: z.output<typeof coordinatorSchema>, cwd: string, core: Operations): ToolDefinition[] {
  const dispatched = new Set<number>();
  const owned = new Set<string>();
  const own = (ids: string[]): string[] => {
    for (const id of ids) if (!owned.has(id)) throw new Error(`Session ${id} was not launched by this coordinator.`);
    return ids;
  };
  // The SDK accepts JSON Schema, including schemas supplied by MCP. Keep Zod as our schema source.
  const schema = (shape: z.ZodType): ToolDefinition["parameters"] => z.toJSONSchema(shape) as ToolDefinition["parameters"];
  const outputSchema = schema(z.object({}).catchall(z.unknown()));
  const result = (value: object): AgentToolResult<undefined> => {
    const text = JSON.stringify(value);
    return { content: [{ type: "text", text }], structuredContent: JSON.parse(text), details: undefined };
  };
  const start = z.object({ taskIndexes: z.array(z.number().int().min(0).max(options.tasks.length - 1)).min(1).optional() });
  const wait = z.object({ sessionIds: z.array(z.string()).min(1).optional(), timeoutMs: z.number().int().min(0).max(55_000).default(30_000) });
  const get = z.object({ sessionId: z.string() });
  return [
    defineTool({
      name: "delegate_start_batch", label: "Start planned delegates", exposure: "codemode",
      description: "Launch caller-approved tasks by zero-based taskIndexes (omit for all unlaunched). Started tasks run once; startup failures can be retried. " +
        "The coordinator also occupies a concurrency slot; start smaller batches if capacity is full. Plans: " +
        JSON.stringify(options.tasks.map((t, index) => ({ index, label: t.label, prompt: t.prompt, model: t.model }))),
      parameters: schema(start), outputSchema,
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const { taskIndexes } = start.parse(params);
        const indexes = [...new Set(taskIndexes ?? options.tasks.map((_, i) => i).filter((i) => !dispatched.has(i)))];
        if (!indexes.length) return result({ sessionIds: [...owned], sessions: [], requested: 0, started: 0 });
        for (const i of indexes) if (dispatched.has(i)) throw new Error(`Task ${i} already dispatched; call delegate_wait or delegate_get.`);
        // Reserve indexes before the first await so parallel script calls cannot double-dispatch.
        indexes.forEach((i) => dispatched.add(i));
        try {
          const batch = await core.startBatch({ cwd, saveDir: options.saveDir, forkFrom: options.forkFrom, tasks: indexes.map((i) => {
            const { research = options.research ?? false, ...task } = options.tasks[i]!;
            return { ...task, tools: [...(task.tools ?? READ_ONLY_TOOLS), ...(research ? RESEARCH_TOOLS : [])],
              durable: false, extensions: false, nativeMcp: research, mcpServers: research ? ["exa"] : [] };
          }) });
          batch.sessionIds.forEach((id) => owned.add(id));
          // Unlike an execution error on a returned session, a startup failure has no child
          // to inspect or resume. Allow that plan item to be retried without rerunning siblings.
          batch.failures?.forEach((f) => dispatched.delete(indexes[f.index]!));
          return result({ ...batch,
            sessions: batch.sessions.map((s) => ({ ...s, taskIndex: indexes[s.index] })),
            ...(batch.failures ? { failures: batch.failures.map((f) => ({ ...f, taskIndex: indexes[f.index] })) } : {}),
          });
        } catch (error) {
          // Core validation/admission failed before launch; the same plan may be retried later.
          indexes.forEach((i) => dispatched.delete(i));
          throw error;
        }
      },
    }),
    defineTool({
      name: "delegate_wait", label: "Wait for delegates", exposure: "codemode",
      description: "Wait for all selected children, or all launched children when sessionIds is omitted. Returns compact per-child state, questions, errors and save diagnostics; use delegate_get for full reports. Cancelling the wait/coordinator leaves children running within their budgets; the caller can answer or abort them with ordinary MCP tools.",
      annotations: { readOnlyHint: true }, parameters: schema(wait), outputSchema,
      async execute(_id, params, signal) {
        const args = wait.parse(params);
        const batch = await core.waitForMany(own(args.sessionIds ?? [...owned]), { timeoutMs: args.timeoutMs, until: "all_settled", signal });
        return result({ ...batch, sessions: batch.sessions.map(({ lastText: _report, ...s }) => s) });
      },
    }),
    defineTool({
      name: "delegate_get", label: "Read delegate report", exposure: "codemode",
      description: "Get one launched child's full report and state, including questions, failures and save diagnostics. store() reports within the SDK's storage limits; print only the conclusions/references the caller needs. Original savedTo files remain independent of summaries.",
      annotations: { readOnlyHint: true }, parameters: schema(get), outputSchema,
      async execute(_id, params) {
        const { sessionId } = get.parse(params);
        own([sessionId]);
        const { label, state, lastText, questions, error, termination, answerState, usage, savedTo, savedChars, saveError } = await core.getState(sessionId, true);
        return result({ sessionId, label, state, lastText, questions, error, termination, answerState, usage, savedTo, savedChars, saveError });
      },
    }),
  ];
}
