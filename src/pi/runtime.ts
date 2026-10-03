import { join } from "node:path";
import {
  createAgentSessionServices,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DIR } from "../config.js";

/**
 * pi's model runtime is expensive to build and safe to share, so every delegate on this
 * server resolves models through the same instance.
 */
let runtimePromise: Promise<ModelRuntime> | undefined;

export function getRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= (async (): Promise<ModelRuntime> => {
    const settingsManager = SettingsManager.create(process.cwd(), AGENT_DIR);
    // SDK hosts do not run Pi's CLI HTTP bootstrap. Use that same initializer:
    // Node 26's native fetch loses headers and gzip decoding with npm Undici's
    // HTTP/2 dispatcher, which breaks successful xAI OAuth refresh responses.
    const { applyHttpProxySettings, configureHttpDispatcher } = await import(
      new URL("./core/http-dispatcher.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
    );
    applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
    configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
    const services = await createAgentSessionServices({
      cwd: process.cwd(),
      agentDir: AGENT_DIR,
      settingsManager,
      resourceLoaderOptions: {
        // Load only the provider extension Pi needs for Antigravity models. Loading every
        // user extension here would run unrelated extension setup in the MCP server.
        additionalExtensionPaths: [
          join(AGENT_DIR, "npm", "node_modules", "pi-antigravity", "src", "index.ts"),
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    return services.modelRuntime;
  })();
  return runtimePromise;
}

/** A model as pi's runtime describes it. */
export type PiModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];
