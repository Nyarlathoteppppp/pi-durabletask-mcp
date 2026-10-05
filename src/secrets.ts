import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR } from "./config.js";

const SENSITIVE_DIRS = [".codex", ".ssh", ".aws", ".gnupg", ".claude"] as const;
const SENSITIVE_FILES = [
  [".grok", "auth.json"],
  [".pi", "agent", "auth.json"],
  ["litellm-gateway", ".env"],
] as const;

/** The same secret rules must apply to files visited inside a recursive search. */
export const SECRET_SEARCH_EXCLUDES = [
  "**/.env", "**/.env/**",
  ...SENSITIVE_DIRS.flatMap((name) => [`**/${name}`, `**/${name}/**`]),
  ...SENSITIVE_FILES.map((segments) => `**/${segments.join("/")}`),
];

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(".."));
}

/**
 * Resolve symlinks in the deepest existing ancestor, then append the rest. A path that does not
 * exist yet, such as a file about to be written, must not hide a symlinked parent directory.
 */
function canonicalize(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      if (dirname(current) === current) return absolute;
      missing.push(basename(current));
    }
  }
}

export function blockedSecretPath(path: string, cwd: string, homeDir = homedir()): string | undefined {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const resolved = canonicalize(absolute);
  const home = canonicalize(homeDir);

  // A sensitive name stays sensitive when it is a symlink to an ordinary filename.
  const segments = [absolute.split(sep), resolved.split(sep)];
  if (segments.some((parts) => parts.includes(".env"))) return resolved;

  for (const name of SENSITIVE_DIRS) {
    const dir = canonicalize(join(home, name));
    if (isInside(dir, resolved)) return resolved;
    // Unrooted copies such as repo/.ssh, including symlinked directories.
    if (segments.some((parts) => parts.includes(name))) return resolved;
  }

  for (const segments of SENSITIVE_FILES) {
    const file = canonicalize(join(home, ...segments));
    if (resolved === file || isInside(file, resolved)) return resolved;
  }
  // Pi keeps its credentials in PI_CODING_AGENT_DIR when that is set, not only under ~/.pi/agent.
  if (resolved === canonicalize(join(AGENT_DIR, "auth.json"))) return resolved;
  return undefined;
}

function pathsFromToolInput(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof input.path === "string" && input.path.trim()) paths.push(input.path);
  if (typeof input.file === "string" && input.file.trim()) paths.push(input.file);
  return paths;
}

export function assertToolPathsAllowed(toolName: string, input: unknown, cwd: string): void {
  if (!input || typeof input !== "object") return;
  for (const path of pathsFromToolInput(input as Record<string, unknown>)) {
    const blocked = blockedSecretPath(path, cwd);
    if (blocked) {
      throw new Error(
        `${toolName} blocked: ${blocked} is a private credential path. Stay inside the delegated cwd.`,
      );
    }
  }
}

export function secretPathGuard(cwd: string): InlineExtension {
  return {
    name: "secret-path-guard",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("tool_call", (event) => {
        assertToolPathsAllowed(event.toolName, event.input, cwd);
      });
    },
  };
}
