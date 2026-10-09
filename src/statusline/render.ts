import type { PublishedSession, StateFile } from "../types.js";
import { ancestors, readAll } from "./state.js";

// No spinner: a status line is re-rendered on the host's schedule, not on ours, so an
// animation frame picked from the clock reads as jitter. Elapsed time carries real
// information at any refresh rate.
const RUNNING = "▸";

// ESC built from its char code so this source file holds no raw control bytes.
const ESC = `${String.fromCharCode(27)}[`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const YELLOW = `${ESC}33m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;

const short = (text: string): string => (text.length <= 14 ? text : `${text.slice(0, 13)}…`);

export function elapsed(startedAt: string | undefined): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/** Pick the delegates belonging to the session this status line is rendering for. */
function mine(servers: StateFile[], cwd: string | undefined): PublishedSession[] {
  // Attribute delegates to *this* session, not merely this repository. The host that
  // launched our server also launched us, so its pid appears in our own ancestry. Two
  // Claude Code sessions on the same repo therefore never show each other's delegates.
  const lineage = new Set(ancestors());
  const ours = servers.filter((s) => s.hostPid !== undefined && lineage.has(s.hostPid));

  // Older state files carry no hostPid; fall back to matching on the workspace.
  const chosen = ours.length ? ours : servers.filter((s) => s.hostPid === undefined);
  const sessions = chosen.flatMap((s) => s.sessions ?? []);
  if (ours.length) return sessions;
  return cwd ? sessions.filter((s) => s.cwd === cwd) : sessions;
}

function detail(s: PublishedSession, progress = false): string {
  const fields: string[] = [s.state];
  if (s.questions > 0) fields.push("waiting questions");
  if (s.model) fields.push(s.model);
  if (s.thinking !== undefined) fields.push(`thinking:${s.thinking}`);
  if (progress) {
    if (s.turns !== undefined) fields.push(`t${s.turns}`);
    const age = elapsed(s.startedAt);
    if (age) fields.push(age);
  }
  return `${short(s.label || s.id)}${DIM}·${fields.join("·")}${RESET}`;
}

export function segment(cwd?: string): string {
  const sessions = mine(readAll(), cwd);
  if (sessions.length === 0) return "";

  const running = sessions.filter((s) => s.state === "running" || s.state === "starting");
  const asking = sessions.filter((s) => s.questions > 0);
  const terminal = sessions.filter((s) => ["done", "error", "aborted"].includes(s.state));
  const done = terminal.filter((s) => s.state === "done").length;
  const failed = terminal.filter((s) => s.state === "error").length;
  const aborted = terminal.filter((s) => s.state === "aborted").length;
  const counts: string[] = [];
  if (done) counts.push(`${GREEN}✓${done}${RESET}`);
  if (failed) counts.push(`${RED}✗${failed}${RESET}`);
  if (aborted) counts.push(`${DIM}⊘${aborted} aborted${RESET}`);

  // Pending answers get a detail slot even when other delegates are still running.
  const active = [...asking, ...running.filter((s) => !(s.questions > 0))];
  if (active.length === 0) {
    const details = terminal.slice(-2).map((s) => detail(s));
    const parts = [...details, ...counts];
    return parts.length ? `${DIM}π${RESET} ${parts.join(" ")}` : "";
  }

  const details = active.slice(0, 3).map((s) => detail(s, true)).join(" ");
  const more = active.length > 3 ? ` ${DIM}+${active.length - 3}${RESET}` : "";
  const ask = asking.length ? ` ${YELLOW}?${asking.length} waiting${RESET}` : "";
  const summary = counts.length ? ` ${counts.join(" ")}` : "";
  return `${DIM}π${RESET} ${RUNNING} ${details}${more}${ask}${summary}`.trim();
}
