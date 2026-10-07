import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * Delegates must name an existing absolute directory that is not the filesystem
 * root or the user's home. Relative paths used to fall through to process.cwd(),
 * which for a Codex-launched MCP is often $HOME or /.
 */
export async function resolveDelegateCwd(cwd: string | undefined): Promise<string> {
  if (!cwd || !cwd.trim()) {
    throw new Error(
      "cwd is required and must be an absolute directory. Delegates do not inherit the MCP process working directory.",
    );
  }
  if (!isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute path.");
  }
  let candidate: string;
  try {
    candidate = await realpath(cwd);
  } catch {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
  if (!(await stat(candidate)).isDirectory()) throw new Error(`cwd must be a directory: ${cwd}`);
  if (candidate === resolve(sep)) {
    throw new Error("cwd must not be the filesystem root.");
  }
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  if (candidate === home) {
    throw new Error("cwd must not be the home directory.");
  }
  return candidate;
}
