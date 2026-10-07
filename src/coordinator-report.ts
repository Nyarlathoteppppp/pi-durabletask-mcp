import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { checkSavePath, saveText } from "./save.js";
import type { Snapshot } from "./types.js";

type Observation = Pick<Snapshot, "sessionId"> & Partial<Pick<Snapshot,
  "label" | "model" | "error" | "termination" | "savedTo" | "savedChars" | "saveError">> & { state?: string };
type ReportRef = { version: number; savedTo: string; savedChars?: number; observedAt: string };
type Entry = Omit<Observation, "sessionId" | "savedTo" | "savedChars"> & {
  taskIndex: number; sessionId?: string; followUpVersion: number; reports: ReportRef[]; observedAt?: string;
};

/** An opted-in result snapshot, never a runtime checkpoint or an ownership/recovery source. */
export function createCoordinatorReport(
  options: { saveDir?: string; tasks: { label?: string }[] }, cwd: string,
) {
  if (options.saveDir === undefined) return undefined;
  const teamId = randomUUID();
  const path = join(options.saveDir, `team-${teamId}.json`);
  const createdAt = new Date().toISOString();
  const tasks: Entry[] = options.tasks.map((t, taskIndex) => ({
    taskIndex, label: t.label, followUpVersion: 0, reports: [],
  }));
  const children = new Map<string, Entry>();
  // Accepted follow-up destinations only identify versions; they are NOT saved report refs.
  const destinations = new Map<string, number>();
  let updatedAt = createdAt;
  let pending = Promise.resolve();

  const version = (sessionId: string): number => children.get(sessionId)?.followUpVersion ?? 0;
  const observe = (sessions: Observation[], versions?: Map<string, number>): void => {
    updatedAt = new Date().toISOString();
    for (const s of sessions) {
      const entry = children.get(s.sessionId);
      if (!entry) continue;
      const run = (s.savedTo ? entry.reports.find((r) => r.savedTo === s.savedTo)?.version
        ?? destinations.get(s.savedTo) : undefined) ?? versions?.get(s.sessionId) ?? entry.followUpVersion;
      // A late observation of the previous run can add its report, but not undo a follow-up receipt.
      if (run === entry.followUpVersion) {
        if (s.label !== undefined) entry.label = s.label;
        if (s.model !== undefined) entry.model = s.model; // actual core model, never the plan's hint
        if (s.state !== undefined) entry.state = s.state;
        entry.error = s.error;
        entry.termination = s.termination;
        entry.saveError = s.saveError;
        entry.observedAt = updatedAt;
      }
      // Only returned successful save receipts are references; never predict a report filename.
      if (s.savedTo && !s.saveError && !entry.reports.some((r) => r.savedTo === s.savedTo)) {
        entry.reports.push({ version: run, savedTo: s.savedTo, savedChars: s.savedChars, observedAt: updatedAt });
      }
    }
  };

  return {
    version,
    observe,
    started(sessions: (Observation & { taskIndex: number })[], failures: { taskIndex: number; error: string }[] = []) {
      updatedAt = new Date().toISOString();
      for (const s of sessions) {
        const entry = tasks[s.taskIndex]!;
        entry.sessionId = s.sessionId;
        children.set(s.sessionId, entry);
      }
      observe(sessions);
      for (const f of failures) {
        const entry = tasks[f.taskIndex]!;
        // A construction failure has no owned child; the plan item remains retryable.
        entry.state = "error";
        entry.error = f.error;
        entry.observedAt = updatedAt;
      }
    },
    followed(receipt: Observation, saveTo?: string) {
      const entry = children.get(receipt.sessionId);
      if (entry) {
        entry.followUpVersion++;
        if (saveTo) destinations.set(saveTo, entry.followUpVersion);
      }
      observe([receipt]);
    },
    async flush(): Promise<{ reportIndex: string } | { reportIndexError: string }> {
      // Merge observations synchronously into the shared projection before awaiting any IO.
      // saveText handles guards/temp files/atomic rename, but rename alone cannot order writers.
      // This per-index chain only orders complete snapshots; it does not lock core operations.
      try {
        const text = JSON.stringify({ schemaVersion: 1, kind: "team-report-snapshot", cwd, teamId, createdAt, updatedAt, tasks }, null, 2) + "\n";
        const write = pending.then(async () => {
          checkSavePath(path, "reportIndex");
          await saveText(path, text);
        });
        pending = write.catch(() => {});
        await write;
        return { reportIndex: path };
      } catch (error) {
        return { reportIndexError: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
