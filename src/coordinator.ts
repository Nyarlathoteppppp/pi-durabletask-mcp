/** Caller-planned, one-level codemode delegation. Lifecycle and admission stay in the core. */
import { defineTool, type ToolDefinition, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BATCH_MAX, MAX_DURATION_MS, MAX_TURNS } from "./config.js";
import { READ_ONLY_TOOLS } from "./permissions.js";
import type { startBatch, waitForMany, getState, followUp } from "./core.js";
import { withNextAction, batchNextAction } from "./tools/shared.js";
import { createCoordinatorReport } from "./coordinator-report.js";
import { resourcesSchema } from "./pi/resources.js";
import { coordinatorOutputs } from "./coordinator-shapes.js";

const RESEARCH_TOOLS = ["mcp__exa__web_search_exa", "mcp__exa__web_fetch_exa"];
// Exact reviewed operations, not a name-pattern or a server's self-reported hint.
// The host's pickTools policy still applies. Browser navigation is allowed;
// clicks, form entry and JS execution are not part of the team read-only workflow.
const TEAM_MCP_TOOLS = {
  github: ["get_file_contents", "search_code", "search_repositories", "issue_read", "pull_request_read", "actions_list", "actions_get", "get_job_logs"],
  serena: ["get_symbols_overview", "find_symbol", "find_referencing_symbols", "activate_project", "initial_instructions"],
  browser: ["agent_browser_open", "agent_browser_snapshot", "agent_browser_scroll", "agent_browser_get_text", "agent_browser_get_url", "agent_browser_close"],
  exa: ["web_search_exa", "web_fetch_exa"],
};
const teamMcpServers = ["github", "serena", "browser", "exa"] as const;
const toolServers = new Map<string, string>(Object.entries(TEAM_MCP_TOOLS).flatMap(([server, tools]) =>
  tools.map((tool) => [`mcp__${server}__${tool}`, server] as const)));
const teamTools = [...READ_ONLY_TOOLS, ...toolServers.keys()];

/** Default only when the caller omits the coordinator prompt; custom strategies stay intact. */
export const COORDINATOR_PROMPT =
  "Coordinate the caller's approved task plan using codemode. Dispatch the planned tasks, wait for them to finish, " +
  "and read their reports before synthesizing. Use batches that fit available concurrency. If children need answers, " +
  "surface their questions and session IDs to the caller. Ask targeted follow-ups only when needed; no mandatory debate round. " +
  "Return the decision or answer, not an inventory of everything checked. For simple agreement or all-pass checks, " +
  "one short sentence plus references is enough; do not enumerate the passing checks or repeat their file/line evidence. " +
  "Expand for actionable findings, substantive disagreements, or failed/incomplete coverage; do not shorten away material findings. " +
  "Merge overlapping conclusions. Omit execution chronology and empty sections; keep detailed verification in the original reports. " +
  "Refer to findings by child label. List each child's label/session ID and returned savedTo once in compact references, " +
  "plus reportIndex once when returned. Keep detailed reasoning in the originals. Agreement is not proof; distinguish evidence from inference. " +
  "Use the language of the task plan.";

export const coordinatorSchema = z.object({
  tasks: z.array(z.object({
    resources: resourcesSchema.optional(),
    prompt: z.string(),
    label: z.string().optional(),
    model: z.string().optional(),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    tools: z.array(z.enum(teamTools)).optional().describe("Exact read-only built-in or reviewed MCP tools; defaults to read/grep/find/ls. MCP tools also require their server in mcpServers and host permission."),
    mcpServers: z.array(z.enum(teamMcpServers)).optional().describe("Configured servers for this member only; selects connections, not tool grants. Not inherited from a fork or the coordinator."),
    research: z.boolean().optional().describe("Override the plan's web research setting; enables only configured Exa search/fetch, subject to server tool permissions."),
    forkFrom: z.string().optional(),
    maxTurns: z.number().int().min(1).max(MAX_TURNS).default(Math.min(10, MAX_TURNS)),
    maxToolCalls: z.number().int().min(1).max(1000).default(12),
    maxDurationMs: z.number().int().min(1000).max(MAX_DURATION_MS).default(Math.min(240_000, MAX_DURATION_MS)),
  }).strict()).min(1).max(BATCH_MAX),
  saveDir: z.string().optional(),
  forkFrom: z.string().optional(),
  research: z.boolean().optional().describe("Enable configured Exa search/fetch for children; requires the two exact tools in PI_DELEGATE_ALLOW_TOOLS. Off when omitted."),
}).strict().superRefine((plan, ctx) => {
  plan.tasks.forEach((task, i) => {
    const servers = new Set([...(task.mcpServers ?? []), ...((task.research ?? plan.research) ? ["exa"] : [])]);
    task.tools?.forEach((tool, j) => {
      const server = toolServers.get(tool);
      if (server && !servers.has(server)) ctx.addIssue({ code: "custom", path: ["tasks", i, "tools", j],
        message: `${tool} requires mcpServers to include ${server}.` });
    });
  });
});

export type CoordinatorOptions = z.input<typeof coordinatorSchema>;
type Operations = { startBatch: typeof startBatch; waitForMany: typeof waitForMany; getState: typeof getState; followUp: typeof followUp };

/** Runtime closures only: neither these definitions nor dispatch membership go into SQLite. */
export function createCoordinatorTools(options: z.output<typeof coordinatorSchema>, cwd: string, core: Operations,
  onReport?: (fields: { reportIndex?: string; reportIndexError?: string }) => void): ToolDefinition[] {
  const report = createCoordinatorReport(options, cwd);
  const reportFields = async () => {
    if (!report) return {};
    const fields = await report.flush();
    onReport?.(fields);
    return fields;
  };
  const dispatched = new Set<number>();
  const owned = new Set<string>();
  /** Dispatches still starting: a wait for "all launched children" includes them. */
  const starting = new Set<Promise<unknown>>();
  const own = (ids: string[]): string[] => {
    for (const id of ids) if (!owned.has(id)) throw new Error(`Session ${id} was not launched by this coordinator.`);
    return ids;
  };
  // The SDK accepts JSON Schema, including schemas supplied by MCP. Keep Zod as our schema source.
  const schema = (shape: z.ZodType): ToolDefinition["parameters"] => z.toJSONSchema(shape) as ToolDefinition["parameters"];
  const result = (value: object): AgentToolResult<undefined> => {
    const text = JSON.stringify(value);
    return { content: [{ type: "text", text }], structuredContent: JSON.parse(text), details: undefined };
  };
  const start = z.object({ taskIndexes: z.array(z.number().int().min(0).max(options.tasks.length - 1)).min(1).optional() });
  const wait = z.object({ sessionIds: z.array(z.string()).min(1).optional(), timeoutMs: z.number().int().min(0).max(55_000).default(30_000) });
  const get = z.object({ sessionId: z.string() });
  const follow = z.object({
    sessionId: z.string(), prompt: z.string(),
    maxTurns: z.number().int().min(1).max(MAX_TURNS).optional(),
    maxToolCalls: z.number().int().min(1).max(1000).optional(),
  }).strict();
  return [
    defineTool({
      name: "delegate_start_batch", label: "Start planned delegates", exposure: "codemode",
      description: "Launch caller-approved tasks by zero-based taskIndexes (omit for all unlaunched). Started tasks run once; startup failures can be retried. " +
        (report ? "With saveDir, reportIndex is a best-effort team snapshot updated by these tools, possibly stale; not recovery or an automatic final refresh. " : "") +
        "Failed scripts leave children running but discard that script's store writes. Recover their IDs/state with delegate_wait({timeoutMs:0}), without launching more work. " +
        "The coordinator also occupies a concurrency slot; start smaller batches if capacity is full. Plans: " +
        JSON.stringify(options.tasks.map((t, index) => ({ index, label: t.label, prompt: t.prompt, model: t.model }))),
      parameters: schema(start), outputSchema: schema(coordinatorOutputs.delegate_start_batch),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const { taskIndexes } = start.parse(params);
        const indexes = [...new Set(taskIndexes ?? options.tasks.map((_, i) => i).filter((i) => !dispatched.has(i)))];
        if (!indexes.length) return result({ sessionIds: [...owned], sessions: [], requested: 0, started: 0, ...await reportFields() });
        for (const i of indexes) if (dispatched.has(i)) throw new Error(`Task ${i} already dispatched; call delegate_wait or delegate_get.`);
        // Reserve indexes before the first await so parallel script calls cannot double-dispatch.
        indexes.forEach((i) => dispatched.add(i));
        let batch: Awaited<ReturnType<Operations["startBatch"]>>;
        try {
          const launched = core.startBatch({ cwd, saveDir: options.saveDir, forkFrom: options.forkFrom, tasks: indexes.map((i) => {
            const { research = options.research ?? false, mcpServers = [], ...task } = options.tasks[i]!;
            const servers = [...new Set([...mcpServers, ...(research ? ["exa"] : [])])];
            return { ...task, resources: task.resources ?? {}, tools: [...new Set([...(task.tools ?? READ_ONLY_TOOLS), ...(research ? RESEARCH_TOOLS : [])])],
              durable: false, extensions: false, nativeMcp: servers.length > 0, mcpServers: servers };
          }) })
            // Owned as soon as started, so a wait tracking this dispatch sees its children.
            .then((started) => {
              started.sessionIds.forEach((id) => owned.add(id));
              // Register metadata before a concurrent wait can observe the launched children.
              report?.started(started.sessions.map((s) => ({ ...s, taskIndex: indexes[s.index]! })),
                started.failures?.map((f) => ({ ...f, taskIndex: indexes[f.index]! })));
              return started;
            });
          starting.add(launched);
          batch = await launched.finally(() => starting.delete(launched));
        } catch (error) {
          // Core validation/admission failed before launch; the same plan may be retried later.
          indexes.forEach((i) => dispatched.delete(i));
          throw error;
        }
        // Only genuine startup failures are retryable. Index IO is outside the launch catch:
        // failure to publish a snapshot must not discard receipts or release dispatched tasks.
        batch.failures?.forEach((f) => dispatched.delete(indexes[f.index]!));
        return result({ ...batch,
          sessions: batch.sessions.map((s) => ({ ...s, taskIndex: indexes[s.index] })),
          ...(batch.failures ? { failures: batch.failures.map((f) => ({ ...f, taskIndex: indexes[f.index] })) } : {}),
          ...await reportFields(),
        });
      },
    }),
    defineTool({
      name: "delegate_wait", label: "Wait for delegates", exposure: "codemode",
      description: "Wait for all selected children, or all launched children when sessionIds is omitted. timeoutMs: max 55000, default 30000 when omitted. Returns compact per-child state, questions, errors and save diagnostics; use delegate_get for full reports. Cancelling the wait/coordinator leaves children running within their budgets; the caller can answer or abort them with ordinary MCP tools.",
      annotations: { readOnlyHint: true }, parameters: schema(wait), outputSchema: schema(coordinatorOutputs.delegate_wait),
      async execute(_id, params, signal) {
        const args = wait.parse(params);
        // A script may dispatch and wait at once; children of a dispatch still starting count as launched.
        if (!args.sessionIds) await Promise.allSettled([...starting]);
        const ids = own(args.sessionIds ?? [...owned]);
        const versions = report && new Map(ids.map((id) => [id, report.version(id)]));
        const batch = await core.waitForMany(ids, { timeoutMs: args.timeoutMs, until: "all_settled", signal });
        report?.observe(batch.sessions, versions);
        if (report && versions) {
          // A wait spanning a follow-up may return the new run without a savedTo version hint.
          // Reobserve only those children, tagged with the version at query time. A failed
          // refresh leaves a possibly stale index, but must not change the original wait result.
          await Promise.allSettled(ids.filter((id) => versions.get(id) !== report.version(id)).map(async (id) => {
            const version = report.version(id);
            const latest = await core.getState(id);
            report.observe([latest], new Map([[id, version]]));
          }));
        }
        const sessions = batch.sessions.map(({ lastText: _report, ...s }) => withNextAction(s));
        return result({ ...batch, sessions, nextAction: batchNextAction(sessions), ...await reportFields() });
      },
    }),
    defineTool({
      name: "delegate_get", label: "Read delegate report", exposure: "codemode",
      description: "Get one launched child's full report, state and follow-up readiness (without renewing quotas), including questions, failures and save diagnostics. store() reports within the SDK's storage limits; print only the conclusions/references the caller needs. Original savedTo files remain independent of summaries.",
      annotations: { readOnlyHint: true }, parameters: schema(get), outputSchema: schema(coordinatorOutputs.delegate_get),
      async execute(_id, params) {
        const { sessionId } = get.parse(params);
        own([sessionId]);
        const versions = report && new Map([[sessionId, report.version(sessionId)]]);
        const snapshot = await core.getState(sessionId, true);
        report?.observe([snapshot], versions);
        const { label, state, lastText, questions, error, termination, answerState, usage, savedTo, savedChars, saveError,
          remainingTurns, canFollowUp, followUpBlockedReason } = snapshot;
        return result({ ...withNextAction({ sessionId, label, state, lastText, questions, error, termination, answerState, usage,
          savedTo, savedChars, saveError, remainingTurns, canFollowUp, followUpBlockedReason }), ...await reportFields() });
      },
    }),
    defineTool({
      name: "delegate_follow_up", label: "Follow up a delegate", exposure: "codemode",
      description: "Ask a finished child launched by this coordinator a targeted question, preserving its history/model/tools. " +
        "Use only when a report or specific evidence is missing; no mandatory debate round. Omit budget fields to use remaining quotas; " +
        "maxTurns/maxToolCalls renew only the supplied quota. Returns a start receipt: wait, then get the updated report. " +
        "With plan saveDir, each follow-up saves to a new file, preserving previous reports. Cancelling the coordinator leaves children running.",
      parameters: schema(follow), outputSchema: schema(coordinatorOutputs.delegate_follow_up),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const { sessionId, prompt, maxTurns, maxToolCalls } = follow.parse(params);
        own([sessionId]);
        const saveTo = options.saveDir ? join(options.saveDir, `${sessionId}.follow-up-${randomUUID()}.md`) : undefined;
        const receipt = await core.followUp(sessionId, prompt, undefined, saveTo, { maxTurns, maxToolCalls });
        report?.followed(receipt, saveTo);
        return result({ ...receipt, nextAction: "wait", ...await reportFields() });
      },
    }),
  ];
}
