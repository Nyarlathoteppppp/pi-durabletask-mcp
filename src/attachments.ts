import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { blockedSecretPath } from "./secrets.js";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Append files the caller attached to a prompt. The caller is the trusted host agent, so the files
 * may lie outside the delegate's cwd (a diff in its scratchpad, say); secret paths are still
 * refused. The text is inlined once, before launch, so durable recovery never reads them again.
 */
export async function withAttachments(prompt: string, paths: string[] | undefined): Promise<string> {
  if (!paths?.length) return prompt;
  if (paths.length > MAX_FILES) throw new Error(`attachments: at most ${MAX_FILES} files.`);
  let total = 0;
  const parts: string[] = [];
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`attachments: ${path} is not an absolute path.`);
    const target = await realpath(path).catch(() => { throw new Error(`attachments: cannot read ${path}.`); });
    if (blockedSecretPath(path, dirname(path)) || blockedSecretPath(target, dirname(target)))
      throw new Error(`attachments: ${path} is a secret path and is never sent to a model.`);
    const handle = await open(target, "r").catch(() => { throw new Error(`attachments: cannot read ${path}.`); });
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`attachments: ${path} is not a regular file.`);
      if (info.size > MAX_FILE_BYTES) throw new Error(`attachments: ${path} is larger than 256 KiB.`);
      if (total + info.size > MAX_TOTAL_BYTES) throw new Error("attachments: more than 1 MiB in total.");
      // Read at most one byte past the limit, and count what was read: the file may grow after stat.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new Error(`attachments: ${path} is larger than 256 KiB.`);
      total += bytesRead;
      if (total > MAX_TOTAL_BYTES) throw new Error("attachments: more than 1 MiB in total.");
      bytes = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    if (bytes.includes(0)) throw new Error(`attachments: ${path} looks binary; attach text files only.`);
    let text: string;
    try { text = utf8.decode(bytes); } catch { throw new Error(`attachments: ${path} is not valid UTF-8 text.`); }
    // A fence longer than any backtick run in the file, so its content cannot end the block.
    let longest = 0;
    for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
    const fence = "`".repeat(Math.max(3, longest + 1));
    parts.push(`Attachment ${JSON.stringify(path)}:\n${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`);
  }
  return `${prompt}\n\nThe caller attached these files as reference material:\n\n${parts.join("\n\n")}`;
}
