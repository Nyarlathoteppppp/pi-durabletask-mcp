import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { Checkpoint } from "../durable.js";
import type { Snapshot } from "../types.js";

/** Match committed results to calls; never blindly replay an interrupted side effect. */
export function repairEntries(saved: Checkpoint): FileEntry[] {
  const manager = SessionManager.inMemory(saved.snapshot.cwd, undefined, saved.entries);
  const messages = manager.buildSessionContext().messages;
  const answered = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall" || answered.has(part.id)) continue;
      const result = saved.results[part.id];
      const nested = nestedResults(saved.results, saved.snapshot.toolCalls, part.id);
      const unknown = "Interrupted by MCP service restart. Execution outcome is unknown; inspect external state before retrying." +
        (nested.length ? "\nCommitted nested tool results (do not replay the interrupted script):\n" +
          JSON.stringify(nested.map(([id, value]) => ({ id, ...value }))) : "");
      manager.appendMessage({ role: "toolResult", toolCallId: part.id, toolName: part.name,
        content: result ? result.content as never : [{ type: "text", text:
          unknown }],
        details: result?.details as never, isError: result?.isError ?? true, timestamp: Date.now() });
      answered.add(part.id);
    }
  }
  return [manager.getHeader()!, ...manager.getEntries()];
}

/** SDK calls can nest again; the trace retains parents whose result is still pending. */
export function nestedResults(results: Checkpoint["results"], calls: Snapshot["toolCalls"], parentId: string) {
  const children = new Map<string, Set<string>>();
  const add = (id: string, parent: string): void => {
    let siblings = children.get(parent);
    if (!siblings) children.set(parent, siblings = new Set());
    siblings.add(id);
  };
  for (const call of calls) {
    if ("id" in call && call.id && call.parentToolCallId) add(call.id, call.parentToolCallId);
  }
  for (const [id, result] of Object.entries(results)) {
    if (result.parentToolCallId) add(id, result.parentToolCallId);
  }
  const descendants = new Set([parentId]);
  for (const id of descendants) {
    for (const child of children.get(id) ?? []) descendants.add(child);
  }
  return Object.entries(results).filter(([id]) => id !== parentId && descendants.has(id));
}
