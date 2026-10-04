import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_DIR,
  DEFAULT_MODEL,
  IGNORE_SCOPE,
  MAX_DURATION_MS,
  MODEL_ALLOWLIST,
  MODEL_DENYLIST,
  STRICT_SCOPE,
} from "../config.js";
import type { ModelScope, PiThinkingLevel } from "../types.js";
import { getRuntime, type PiModel } from "./runtime.js";

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The delegate may only use models pi itself has scoped, plus anything served by a
 * custom provider from models.json, since those are declared by hand and are the point of
 * having a custom provider at all.
 *
 * Mirrors pi's settings precedence: project `<cwd>/.pi/settings.json` overrides global.
 * An empty or missing enabledModels means no scoping, matching pi's own no-op default.
 */
export function modelScope(cwd?: string): ModelScope | undefined {
  if (IGNORE_SCOPE) return undefined;
  const global = readJson(join(AGENT_DIR, "settings.json"))?.enabledModels;
  const local = cwd ? readJson(join(cwd, ".pi", "settings.json"))?.enabledModels : undefined;
  const enabled = local ?? global;
  if (!Array.isArray(enabled) || enabled.length === 0) return undefined;

  const providers = readJson(join(AGENT_DIR, "models.json"))?.providers;
  const customProviders =
    STRICT_SCOPE || !providers || typeof providers !== "object" ? [] : Object.keys(providers);
  return { enabled: new Set(enabled as string[]), customProviders: new Set(customProviders) };
}

export function inScope(scope: ModelScope | undefined, provider: string, id: string): boolean {
  if (!scope) return true;
  const ref = `${provider}/${id}`;
  // enabledModels entries may be globs ("xai/*"), same as pi's own scoped-models matching.
  return scope.customProviders.has(provider) || [...scope.enabled].some((p) => matchesModelPattern(p, ref));
}

/** A second, MCP-only boundary that never changes pi's interactive model scope. */
export function inDelegateAllowlist(provider: string, id: string): boolean {
  return MODEL_ALLOWLIST.size === 0 || MODEL_ALLOWLIST.has(`${provider}/${id}`);
}

function matchesModelPattern(pattern: string, ref: string): boolean {
  if (!pattern.includes("*")) return pattern === ref;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(ref);
}

export function inDelegateDenylist(provider: string, id: string): boolean {
  const ref = `${provider}/${id}`;
  return [...MODEL_DENYLIST].some((pattern) => matchesModelPattern(pattern, ref));
}

/**
 * The model a spawn without `model` gets: PI_DELEGATE_MODEL, else Pi's configured default for this
 * cwd (project settings over global). Undefined when neither names one.
 */
export function defaultModelRef(cwd?: string): string | undefined {
  if (DEFAULT_MODEL) return DEFAULT_MODEL;
  const local = cwd ? readJson(join(cwd, ".pi", "settings.json")) : undefined;
  const global = readJson(join(AGENT_DIR, "settings.json"));
  const provider = (local?.defaultProvider ?? global?.defaultProvider) as string | undefined;
  const model = (local?.defaultModel ?? global?.defaultModel) as string | undefined;
  return provider && model ? `${provider}/${model}` : undefined;
}

export interface ScopedModel {
  provider: string;
  id: string;
  ref: string;
}

/** Refuse a thinking request that pi would silently clamp to off for this model. */
export function assertThinkingSupported(
  model: Pick<PiModel, "provider" | "id" | "reasoning" | "thinkingLevelMap"> | undefined,
  thinking: PiThinkingLevel | undefined,
): void {
  if (!model || !thinking || thinking === "off") return;
  const levelMap = model.thinkingLevelMap as Record<string, string | null | undefined> | undefined;
  if (!model.reasoning || (levelMap && !levelMap[thinking]))
    throw new Error(
      `Model ${model.provider}/${model.id} does not support thinking: ${thinking}. ` +
        "Omit thinking or choose a level declared by pi for this model.",
    );
}

/**
 * Models the delegate can actually use: in scope AND backed by a provider that is
 * authenticated. A scoped model with no credentials is not usable, so it is not offered.
 */
export async function scopedModels(cwd?: string): Promise<ScopedModel[]> {
  const scope = modelScope(cwd);
  const rt = await getRuntime();
  const available = await rt.getAvailable();
  return available
    .map((m) => ({ provider: m.provider, id: m.id, ref: `${m.provider}/${m.id}` }))
    .filter((m) => inScope(scope, m.provider, m.id))
    .filter((m) => inDelegateAllowlist(m.provider, m.id))
    .filter((m) => !inDelegateDenylist(m.provider, m.id));
}

export interface Health {
  available: number;
  usable: string[];
  /** Providers whose credentials could not be resolved, with the reason. Their models are left out of `usable`. */
  failing: Record<string, string>;
}

/** An OAuth token that would expire during the longest delegate run is refreshed up front. */
const AUTH_VALIDITY_MS = MAX_DURATION_MS + 5 * 60_000;
const AUTH_TIMEOUT_MS = 15_000;

/**
 * Resolve a provider's credentials as a request would, refreshing OAuth tokens that would
 * expire mid-run. Returns the failure, if any. API keys are checked for presence, not validity.
 */
async function providerProblem(provider: string): Promise<string | undefined> {
  const rt = await getRuntime();
  try {
    const auth = await rt.getAuth(provider, { minOAuthValidityMs: AUTH_VALIDITY_MS, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
    return auth ? undefined : "no credentials configured";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Fail at spawn, before a session exists, rather than on the delegate's first model call. */
export async function assertProviderReady(provider: string): Promise<void> {
  const problem = await providerProblem(provider);
  if (problem)
    throw new Error(`Provider ${provider} is not usable right now: ${problem}. ` +
      `Choose a model from another provider, or re-authenticate ${provider} in pi.`);
}

/**
 * Refuse to operate at all when pi is absent or unusable. A delegate server that
 * silently degrades is worse than one that will not start.
 */
export async function preflight(cwd?: string): Promise<Health> {
  if (!existsSync(AGENT_DIR))
    throw new Error(
      `pi is not configured: ${AGENT_DIR} does not exist. Install pi ` +
        `(npm i -g @earendil-works/pi-coding-agent), run \`pi\` once, and \`/login\` a provider.`,
    );

  const rt = await getRuntime();
  const runtimeError = rt.getError();
  if (runtimeError) throw new Error(`pi's model runtime failed to load: ${runtimeError}`);

  const available = await rt.getAvailable();
  if (available.length === 0)
    throw new Error(
      `pi has no authenticated provider. Run \`pi\` and \`/login\`, or put an API key in ` +
        `${join(AGENT_DIR, "auth.json")}. Environment variables are unreliable here because MCP ` +
        `hosts launch servers with a stripped environment.`,
    );

  const usable = await scopedModels(cwd);
  if (usable.length === 0) {
    const scope = modelScope(cwd);
    throw new Error(
      MODEL_ALLOWLIST.size
        ? `No usable model intersects PI_DELEGATE_MODEL_ALLOWLIST ` +
          `[${[...MODEL_ALLOWLIST].join(", ")}]. Check exact IDs with pi --list-models and authentication.`
        : MODEL_DENYLIST.size
        ? `No usable model remains after PI_DELEGATE_MODEL_DENYLIST ` +
          `[${[...MODEL_DENYLIST].join(", ")}]. Check the exclusions and pi authentication.`
        : scope
        ? `No usable model. pi's enabledModels scope [${[...scope.enabled].join(", ")}] does not ` +
          `intersect any authenticated provider. Widen it via pi's /scoped-models, log in to the ` +
          `matching provider, or set PI_DELEGATE_IGNORE_SCOPE=1.`
        : "No usable model: pi reports authenticated providers but none carry a usable model.",
    );
  }
  const healthy = await withHealthyProviders(usable);
  // Models exist, but every provider behind them failed to resolve credentials: nothing can run.
  if (healthy.models.length === 0)
    throw new Error("No usable model: the credentials of every provider in scope failed to resolve. " +
      Object.entries(healthy.failing).map(([provider, problem]) => `${provider}: ${problem}`).join("; ") +
      ". Re-authenticate in pi, then call init again.");
  return { available: available.length, usable: healthy.models.map((m) => m.ref), failing: healthy.failing };
}

/** Drop models of providers whose credentials fail to resolve, reporting why. */
async function withHealthyProviders(models: ScopedModel[]): Promise<{ models: ScopedModel[]; failing: Record<string, string> }> {
  const failing: Record<string, string> = {};
  await Promise.all([...new Set(models.map((m) => m.provider))].map(async (provider) => {
    const problem = await providerProblem(provider);
    if (problem) failing[provider] = problem;
  }));
  // hasOwn, not `in`: a provider named like an Object.prototype member must not count as failing.
  return { models: models.filter((m) => !Object.hasOwn(failing, m.provider)), failing };
}

/** The models a spawn could actually use right now: in scope and policy, with working credentials. */
export async function usableModels(cwd?: string): Promise<{ models: ScopedModel[]; failing: Record<string, string> }> {
  return withHealthyProviders(await scopedModels(cwd));
}

/**
 * Resolve "provider/modelId" to a model. Splits on the FIRST slash so
 * "openrouter/stealth/ox-alpha" yields provider=openrouter, id=stealth/ox-alpha.
 *
 * Throws on a miss. pi silently falls back to the default model when handed
 * `undefined`, which is how you end up billing a model you never asked for.
 */
export async function resolveModel(spec: string | undefined, cwd?: string): Promise<PiModel | undefined> {
  if (!spec) return undefined;
  const rt = await getRuntime();
  const slash = spec.indexOf("/");
  let model: PiModel | undefined;
  if (slash > 0) model = rt.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  model ??= rt.getModels().find((m) => m.id === spec);

  if (!model)
    throw new Error(
      `Model not found: ${spec}. Use "provider/modelId", e.g. "openrouter/stealth/ox-alpha". ` +
        `Call the "models" tool to list what is available.`,
    );

  if (!inDelegateAllowlist(model.provider, model.id)) {
    throw new Error(
      `Model ${model.provider}/${model.id} is blocked by PI_DELEGATE_MODEL_ALLOWLIST. ` +
        `Allowed delegates: ${[...MODEL_ALLOWLIST].join(", ")}.`,
    );
  }

  if (inDelegateDenylist(model.provider, model.id)) {
    throw new Error(
      `Model ${model.provider}/${model.id} is blocked by PI_DELEGATE_MODEL_DENYLIST. ` +
        `Excluded patterns: ${[...MODEL_DENYLIST].join(", ")}.`,
    );
  }

  const scope = modelScope(cwd);
  if (!inScope(scope, model.provider, model.id)) {
    const allowed = (await scopedModels(cwd)).map((m) => m.ref);
    throw new Error(
      `Model ${model.provider}/${model.id} is out of scope. Allowed here: ${allowed.join(", ")}. ` +
        `Widen it in pi's own settings (enabledModels, via /scoped-models) or set ` +
        `PI_DELEGATE_IGNORE_SCOPE=1 on this server.`,
    );
  }
  return model;
}
