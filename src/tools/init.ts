import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALLOW_ALL,
  DEFAULT_MODEL,
  HISTORY_LIMIT,
  LIST_CAP,
  MAX_CONCURRENT,
  MAX_DURATION_MS,
  MAX_TURNS,
  MODEL_ALLOWLIST,
  MODEL_DENYLIST,
  RUN_DEFAULT_DURATION_MS,
  RUN_DEFAULT_TURNS,
  SPAWN_DEFAULT_DURATION_MS,
  SPAWN_DEFAULT_TURNS,
  TRACE_ARGS,
  TRACE_RESULT,
} from "../config.js";
import { PERMITTED, READ_ONLY_TOOLS } from "../permissions.js";
import { modelScope, preflight, scopedModels } from "../pi/models.js";
import { json, markInitialised } from "./shared.js";
import { recoverAbandoned } from "../registry.js";
import { DURABLE_DIR } from "../durable.js";
import { VERSION as PI_SDK_VERSION, getPackageDir } from "@earendil-works/pi-coding-agent";

export function registerInit(server: McpServer): void {
  server.registerTool(
    "init",
    {
      description:
        "READ THIS FIRST. Reports what this server can reach and how to drive it: permitted tools, " +
        "the default model, models available per provider, and the recipes for delegating. " +
        "Every other tool refuses until this has been called once.",
      inputSchema: {
        models: z.string().optional().describe('Substring to filter the model list, e.g. "deepseek"'),
        cwd: z
          .string()
          .optional()
          .describe("Repository you intend to delegate in; picks up its project-local pi model scope"),
      },
    },
    async ({ models: filter, cwd }) => {
      // Throws if pi is missing, unauthenticated, or scoped down to nothing. The gate stays
      // shut in that case, so the other tools remain closed rather than half-working.
      const health = await preflight(cwd);
      await recoverAbandoned();
      markInitialised();
      const scope = modelScope(cwd);
      const all = (await scopedModels(cwd)).map((m) => m.ref);
      const hits = filter ? all.filter((m) => m.toLowerCase().includes(filter.toLowerCase())) : all;

      // enabledModels alone does not explain the list: inScope() also lets through every
      // model of a custom provider. Saying so here stops "scope says 3, this says 15".
      const bypassed = scope ? hits.filter((ref) => scope.customProviders.has(ref.slice(0, ref.indexOf("/")))) : [];

      const byProvider: Record<string, number> = {};
      for (const id of hits) {
        const provider = id.slice(0, id.indexOf("/"));
        byProvider[provider] = (byProvider[provider] ?? 0) + 1;
      }

      return json({
        // Deliberately does not report pi's total authenticated model count. Advertising 396
        // models when 15 are in scope invites the caller to pick one that is a hard error.
        pi: { ok: true, usableModels: health.usable.length, sdkVersion: PI_SDK_VERSION, sdkPath: getPackageDir() },
        durability: { enabled: true, storage: DURABLE_DIR,
          recovery: "init resumes abandoned tasks from saved history. Completed tool calls are retained; interrupted calls get an unknown-outcome error and are not automatically replayed. Original deadlines and turn budgets still apply." },
        what:
          "pi-delegate-mcp hands a task to the pi coding agent. The delegate reads files and reasons " +
          "on its own budget, then returns a result. Its context never enters yours.",

        permissions: {
          toolsAllowedHere: ALLOW_ALL ? "any (PI_DELEGATE_ALLOW_WRITE=1)" : [...PERMITTED],
          defaultIfYouOmitTools: [...READ_ONLY_TOOLS],
          warning:
            "This is not a sandbox. pi has no permission system, so a delegate holding `bash` can " +
            "write and delete files whatever its tool list says. Your prompt is the only other guardrail.",
        },

        models: {
          defaultWhenYouOmitModel: DEFAULT_MODEL ?? "(pi's own configured default)",
          delegateAllowlist: MODEL_ALLOWLIST.size ? [...MODEL_ALLOWLIST] : "not set",
          delegateDenylist: MODEL_DENYLIST.size ? [...MODEL_DENYLIST] : "not set",
          format: 'Pass "provider/modelId". An unresolvable name is a hard error, never a silent fallback.',
          scoped: MODEL_ALLOWLIST.size
            ? "Only models in PI_DELEGATE_MODEL_ALLOWLIST that also pass pi's own scope may be used."
            : MODEL_DENYLIST.size && !scope
            ? "Every authenticated pi model is usable except models matching PI_DELEGATE_MODEL_DENYLIST."
            : MODEL_DENYLIST.size
            ? "Models matching PI_DELEGATE_MODEL_DENYLIST are excluded; the remaining list also follows pi's own scope."
            : scope
            ? "Only the models below may be used. Anything else is a hard error."
            : "pi has no enabledModels set, so every configured model is usable.",
          ...(bypassed.length
            ? {
                scopeNote:
                  `pi's enabledModels lists ${scope ? scope.enabled.size : 0}, but ${bypassed.length} more are ` +
                  `offered here because they belong to a custom provider in models.json ` +
                  `(${[...(scope?.customProviders ?? [])].join(", ")}), which bypasses the scope by design. ` +
                  "Set PI_DELEGATE_STRICT_SCOPE=1 to honour enabledModels exactly.",
              }
            : {}),
          total: hits.length,
          // A scoped set is small by construction, so it is listed in full and the caller
          // never has to guess whether a name is allowed. Only an unscoped pi can be large
          // enough to flood a context, and that is summarised rather than truncated silently.
          ...(hits.length > LIST_CAP
            ? {
                byProvider,
                note:
                  `${hits.length} models is too many to list. Narrow it with the \`models\` argument, ` +
                  "then page through results with offset and limit.",
              }
            : { available: hits }),
        },

        howToDelegate: [
          "1. `spawn` for real work. It returns a sessionId immediately, nothing blocks. Give it an " +
            "absolute `cwd` (required), plus your own `id` and a `label` so you can trace it later.",
          "2. `status` to poll. Read `state`, `turns`, and `toolCalls` (the ordered tool trace). " +
            "Add `verbose: true` to see tool results.",
          "3. `wait` to pause up to 55 seconds for progress or completion. Cancelling a wait does " +
            "not abort the background delegate, so repeat it instead of guessing that a live task is stuck.",
          "4. `steer` if it goes the wrong way. The message lands after its current tool call, " +
            "before the next model call. Cheaper than aborting and restarting.",
          "5. `answer` when `status` shows a non-empty `questions` array, which blocks the delegate " +
            "until you reply. Only extensions can ask, so this never fires unless you spawned with " +
            "`extensions: true`.",
          "6. `follow_up` to give a finished delegate another turn on the same session. Turns and " +
            "wall-clock already spent still count toward the original budget.",
          "7. `sessions` lists everything including finished runs; `forget` drops one.",
          "`spawn_batch` fans out several delegates at once. `run` blocks until done, so keep it for " +
            "questions that finish in under a minute.",
        ],

        gotchas: [
          "Slow models plus many turns means minutes, not seconds. Prefer `spawn` over `run`.",
          "Every delegate has a turn budget and wall-clock deadline. Near the turn limit it is " +
            "steered once to conclude; at the limit it is aborted with a termination reason.",
          "The delegate cannot see your conversation. Put every fact it needs into `prompt`.",
          "cwd is required, absolute, and must not be `/` or `$HOME`. Relative paths are refused.",
          "Delegates do not load skills or AGENTS.md/CLAUDE.md. Credential paths " +
            "(~/.codex, ~/.ssh, ~/.aws, ~/.gnupg, ~/.claude, auth.json, **/.env) are blocked.",
          "pi extensions are off by default because they add startup cost and can misbehave. " +
            "Pass `extensions: true` only if the delegate needs them.",
        ],

        limits: {
          maxConcurrent: MAX_CONCURRENT,
          hardMaxTurns: MAX_TURNS,
          hardMaxDurationMs: MAX_DURATION_MS,
          runDefaults: { maxTurns: RUN_DEFAULT_TURNS, maxDurationMs: RUN_DEFAULT_DURATION_MS },
          spawnDefaults: { maxTurns: SPAWN_DEFAULT_TURNS, maxDurationMs: SPAWN_DEFAULT_DURATION_MS },
          historyKept: HISTORY_LIMIT,
          traceArgsChars: TRACE_ARGS,
          traceResultChars: TRACE_RESULT,
        },
      });
    },
  );
}
