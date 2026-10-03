import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every environment variable this server reads, in one place. Scattering `process.env`
 * across modules is how the table in the README drifts out of date.
 */

interface PackageJson {
  name: string;
  version: string;
}

/** Single source of truth for the version the MCP handshake reports. */
const pkg = createRequire(import.meta.url)("../package.json") as PackageJson;

export const PKG_NAME = pkg.name;
export const PKG_VERSION = pkg.version;

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bounded = (value: string | undefined, fallback: number, ceiling: number): number =>
  Math.min(num(value, fallback), ceiling);

/** Where pi keeps auth.json, settings.json and extensions. */
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

/**
 * Opt-in escape hatches. Without one, the delegate can never write, edit, or run shell.
 *
 * Neither is a sandbox. pi has no permission system, so granting `bash` grants every
 * capability the user running this server has, writes included.
 */
export const ALLOW_ALL = process.env.PI_DELEGATE_ALLOW_WRITE === "1";
export const ALLOW_EXTRA = (process.env.PI_DELEGATE_ALLOW_TOOLS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Model used when a call omits `model`. Undefined means pi's own configured default. */
export const DEFAULT_MODEL = process.env.PI_DELEGATE_MODEL || undefined;

/**
 * Optional delegate-only model allowlist. This is deliberately independent of pi's
 * enabledModels so an MCP host can expose a narrow worker pool without shrinking the
 * interactive pi model picker.
 */
export const MODEL_ALLOWLIST = new Set(
  (process.env.PI_DELEGATE_MODEL_ALLOWLIST || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean),
);

/** Optional delegate-only denylist. Supports exact model refs and `*` wildcards. */
export const MODEL_DENYLIST = new Set(
  (process.env.PI_DELEGATE_MODEL_DENYLIST || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean),
);

/** Ignore pi's enabledModels scope entirely. */
export const IGNORE_SCOPE = process.env.PI_DELEGATE_IGNORE_SCOPE === "1";

/**
 * Honour enabledModels exactly. Off by default, which lets every model of a custom
 * provider through on the grounds that declaring one by hand is already an intent to use
 * it. Turn this on when you want the offered list to match enabledModels and nothing more.
 */
export const STRICT_SCOPE = process.env.PI_DELEGATE_STRICT_SCOPE === "1";

/** Finished sessions stay readable for later review; oldest are evicted first. */
export const HISTORY_LIMIT = num(process.env.PI_DELEGATE_HISTORY, 50);

/** Ceiling on one `spawn_batch` call. A fan-out this wide is usually a planning mistake. */
export const BATCH_MAX = num(process.env.PI_DELEGATE_BATCH_MAX, 4);

/** Hard ceiling across every active spawn/run/batch session in this server process. */
export const MAX_CONCURRENT = num(process.env.PI_DELEGATE_MAX_CONCURRENT, 4);

/** Absolute per-session budgets. Callers may lower these but can never exceed them. */
export const MAX_TURNS = num(process.env.PI_DELEGATE_MAX_TURNS, 50);
export const MAX_DURATION_MS = num(process.env.PI_DELEGATE_MAX_DURATION_MS, 15 * 60_000);

/** `run` is deliberately short; background sessions get room for real implementation work. */
export const RUN_DEFAULT_TURNS = bounded(process.env.PI_DELEGATE_RUN_TURNS, 12, MAX_TURNS);
export const RUN_DEFAULT_DURATION_MS = bounded(
  process.env.PI_DELEGATE_RUN_DURATION_MS,
  5 * 60_000,
  MAX_DURATION_MS,
);
export const SPAWN_DEFAULT_TURNS = bounded(process.env.PI_DELEGATE_SPAWN_TURNS, 30, MAX_TURNS);
export const SPAWN_DEFAULT_DURATION_MS = bounded(
  process.env.PI_DELEGATE_SPAWN_DURATION_MS,
  10 * 60_000,
  MAX_DURATION_MS,
);

/** Above this, `init` summarises models by provider instead of dumping every ref. */
export const LIST_CAP = num(process.env.PI_DELEGATE_LIST_CAP, 60);

/** Progress notification interval during `run`, which resets the host's request timeout. */
export const PROGRESS_MS = num(process.env.PI_DELEGATE_PROGRESS_MS, 15_000);

/** Tool arguments and results are clipped before entering the trace. */
export const TRACE_ARGS = num(process.env.PI_DELEGATE_TRACE_ARGS, 400);
export const TRACE_RESULT = num(process.env.PI_DELEGATE_TRACE_RESULT, 600);

/** Days a finished durable delegate is kept when its spawn names no `retentionDays`. follow_up restarts the clock. */
export const RETENTION_DAYS = num(process.env.PI_DELEGATE_RETENTION_DAYS, 7);
export const MAX_RETENTION_DAYS = 365;
export const DAY_MS = 86_400_000;

/** Above this, the oldest finished durable delegates are deleted early. Unfinished ones never are. */
export const STORAGE_LIMIT_BYTES = num(process.env.PI_DELEGATE_STORAGE_LIMIT_MB, 1024) * 1024 * 1024;

/** Claims of a job without progress before recovery stops resuming it and reports an error. */
export const MAX_RECOVERY_ATTEMPTS = num(process.env.PI_DELEGATE_MAX_RECOVERY_ATTEMPTS, 3);

/** Where the status line reads live session state from. */
export const STATE_DIR =
  process.env.PI_DELEGATE_STATE_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-delegate-mcp");
