import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { blockedSecretPath } from "./secrets.js";

/** A saved text up to this length is also returned inline: reading the file back would cost more. */
const INLINE_MAX_CHARS = 1_500;

/** Whether a result should leave out lastText because it was written to savedTo. */
export const omitsSavedText = (r: { savedTo?: string | undefined; savedChars?: number | undefined }): boolean =>
  Boolean(r.savedTo) && (r.savedChars ?? 0) > INLINE_MAX_CHARS;

/** Refuse a path before anything starts, so a bad saveTo fails the call rather than the result. */
export function checkSavePath(path: string, name = "saveTo"): void {
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  if (blockedSecretPath(path, dirname(path))) throw new Error(`${name}: ${path} is a secret path`);
}

export async function saveText(path: string, text: string): Promise<{ savedTo: string; savedChars: number }> {
  checkSavePath(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
  return { savedTo: path, savedChars: text.length };
}

export function saveDirPath(dir: string, sessionId: string): string {
  if (!isAbsolute(dir)) throw new Error("saveDir must be an absolute path");
  if (/[\\/]/.test(sessionId)) throw new Error("sessionId must not contain a path separator");
  return join(dir, `${sessionId}.md`);
}
