import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Each MCP process stands for one Claude/Codex window.
const directory = await mkdtemp(join(tmpdir(), "pi-delegate-handoff-"));
const agentDir = join(directory, "agent");
const repo = join(directory, "repo");
const clients = new Set();
const sockets = new Set();
const waitUntil = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Handoff fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (body.includes("HOLD")) return;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "OK" }, null], [{}, "stop"]])
    res.write(`data: ${JSON.stringify({ id: "handoff", object: "chat.completion.chunk", created: 1, model: "one",
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  res.end("data: [DONE]\n\n");
});
http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));

const window = async (env = {}) => {
  const client = new Client({ name: "handoff-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(directory, "state"),
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", ...env } });
  const host = { client, transport };
  clients.add(host);
  await client.connect(transport);
  host.call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  return host;
};
const close = async (host) => { await host.client.close(); clients.delete(host); };
const crash = async (host) => {
  process.kill(host.transport.pid, "SIGKILL");
  await waitUntil(() => { try { process.kill(host.transport.pid, 0); return false; } catch { return true; } });
  await close(host);
};
const settle = (host, id) => host.call("wait", { sessionId: id, until: "settled", timeoutMs: 15000 });
const save = (host, sessionId, name) => host.call("handoff", { action: "save", cwd: repo, name, sessionId,
  goal: `goal of ${sessionId}`, completed: "read the code", next: "fix the bug" });
const read = (host, name) => host.call("handoff", { action: "read", cwd: repo, ...(name ? { name } : {}) });

try {
  await mkdir(agentDir, { recursive: true });
  await mkdir(repo, { recursive: true });
  const canonicalRepo = await realpath(repo);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 16000,
      maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));

  // A handoff.sqlite from the first handoff commit has no seq column; it is migrated on open.
  await mkdir(join(directory, "state"), { recursive: true });
  const legacy = new DatabaseSync(join(directory, "state", "handoff.sqlite"));
  legacy.exec(`PRAGMA journal_mode=WAL; CREATE TABLE handoffs (agent_dir TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT NOT NULL,
    session_id TEXT NOT NULL, session_started_at TEXT, durable INTEGER NOT NULL, goal TEXT NOT NULL,
    completed TEXT NOT NULL, next TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY (agent_dir, cwd, name));`);
  // Its notes keep their order; "b" and "c" were saved in the same millisecond, "c" second.
  const legacyRepo = join(directory, "legacy-repo");
  await mkdir(legacyRepo, { recursive: true });
  const legacyNote = legacy.prepare(`INSERT INTO handoffs VALUES (?, ?, ?, 'gone', NULL, 1, 'g', 'c', 'n', ?)`);
  for (const [name, savedAt] of [["a", "2026-10-01T00:00:00.000Z"], ["b", "2026-10-02T00:00:00.000Z"], ["c", "2026-10-02T00:00:00.000Z"]])
    legacyNote.run(agentDir, await realpath(legacyRepo), name, savedAt);
  legacy.close();
  // Two windows open it for the first time together; a writer holds it meanwhile, so both see the old schema.
  const blocker = new DatabaseSync(join(directory, "state", "handoff.sqlite"));
  blocker.exec("BEGIN IMMEDIATE");
  const pair = [await window(), await window()];
  const reads = pair.map((host) => host.call("handoff", { action: "read", cwd: legacyRepo }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  blocker.exec("COMMIT");
  blocker.close();
  for (const migrated of await Promise.all(reads)) assert.deepEqual(migrated.names, ["c", "b", "a"]);
  for (const host of pair) await close(host);

  // Nothing saved yet; saving needs a real session.
  let old = await window();
  assert.equal((await read(old)).found, false);
  await assert.rejects(() => save(old, "nope"), /Unknown sessionId/);

  // A session belongs to one repository: a note for another repository is refused.
  const otherRepo = join(directory, "other-repo");
  await mkdir(otherRepo, { recursive: true });
  await old.call("spawn", { cwd: repo, id: "here", prompt: "plain", tools: [] });
  await settle(old, "here");
  await assert.rejects(() => old.call("handoff", { action: "save", cwd: otherRepo, sessionId: "here",
    goal: "g", completed: "c", next: "n" }), /works in .*not/);

  // 1. A memory-only session cannot cross windows, and saving it says so.
  await old.call("spawn", { cwd: repo, id: "memo", prompt: "plain", tools: [] });
  await settle(old, "memo");
  assert.match((await save(old, "memo", "memo")).warning, /memory-only/);
  assert.equal((await read(old, "memo")).resumeHint, "status_then_follow_up", "the window that runs it can continue");

  // 2. A finished durable session is read and continued from a new window.
  await old.call("spawn", { cwd: repo, id: "finished", label: "saved review", prompt: "plain", tools: [], durable: true, maxTurns: 3 });
  await settle(old, "finished");
  await save(old, "finished", "finished");
  await old.call("spawn", { cwd: otherRepo, id: "other-project", prompt: "plain", tools: [], durable: true });
  await settle(old, "other-project");
  assert.ok((await old.call("sessions", { cwd: repo })).sessions.every((s) => s.cwd === canonicalRepo));
  await close(old);
  let fresh = await window();
  assert.equal((await read(fresh, "memo")).resumeHint, "session_not_recoverable");
  const finished = await read(fresh, "finished");
  assert.equal(finished.resumeHint, "status_then_follow_up");
  assert.equal(finished.handoff.next, "fix the bug");
  assert.equal(finished.remainingTurns, 2);
  assert.equal(finished.canFollowUp, true);
  const history = await fresh.call("sessions", { cwd: repo, state: "done" });
  assert.equal(history.count, 0, "browsing does not load stored conversations");
  assert.deepEqual(history.stored.map((s) => s.sessionId), ["finished"]);
  assert.deepEqual([history.stored[0].label, history.stored[0].remainingTurns, history.stored[0].canFollowUp], ["saved review", 2, true]);
  assert.equal((await fresh.call("sessions", { cwd: repo, state: "error" })).stored.length, 0);
  const savedStatus = await fresh.call("status", { sessionId: "finished" });
  assert.deepEqual([savedStatus.lastText, savedStatus.remainingTurns, savedStatus.canFollowUp], ["OK", 2, true]);
  assert.equal((await settle(fresh, "finished")).remainingTurns, 2);
  const summary = await fresh.call("wait", { sessionIds: ["finished"], until: "all_settled", timeoutMs: 250 });
  assert.equal(summary.sessions[0].remainingTurns, 2);
  assert.equal(summary.sessions[0].canFollowUp, true);
  await close(fresh);

  // 3. The previous window is still open: its running session is not grabbed, and its finished
  //    one reads fine but cannot be followed up from here yet.
  old = await window();
  await old.call("spawn", { cwd: repo, id: "held-done", prompt: "plain", tools: [], durable: true });
  await settle(old, "held-done");
  await save(old, "held-done", "held-done");
  await old.call("spawn", { cwd: repo, id: "running", prompt: "HOLD", tools: [], durable: true });
  await save(old, "running", "running");
  fresh = await window({ PI_DELEGATE_RECOVERY_INTERVAL_MS: "300" });
  assert.equal((await read(fresh, "running")).resumeHint, "old_process_owns_session");
  const heldDone = await read(fresh, "held-done");
  assert.equal(heldDone.resumeHint, "status_then_follow_up");
  assert.equal(heldDone.heldByAnotherProcess, true);
  assert.match(heldDone.howToResume, /follow_up works only after that window closes/);
  await assert.rejects(() => fresh.call("follow_up", { sessionId: "held-done", prompt: "x" }), /another MCP process/);

  // 4. The previous window crashes while this one is already open and idle: this one resumes the
  //    session on its own, without a restart.
  await crash(old);
  await waitUntil(async () => (await read(fresh, "running")).resumeHint === "wait_running_session");

  // 5. Unfinished and unowned, waiting for a free slot: two abandoned, room for one.
  await fresh.call("spawn", { cwd: repo, id: "running-2", prompt: "HOLD again", tools: [], durable: true });
  await save(fresh, "running-2", "running-2");
  await crash(fresh);
  fresh = await window({ PI_DELEGATE_MAX_CONCURRENT: "1" });
  const hints = [(await read(fresh, "running")).resumeHint, (await read(fresh, "running-2")).resumeHint].sort();
  assert.deepEqual(hints, ["awaiting_recovery", "wait_running_session"]);
  await close(fresh);

  // 6. Forgotten, and the id later reused for different work: the note does not follow the new session.
  fresh = await window();
  await fresh.call("forget", { sessionId: "finished" });
  assert.equal((await read(fresh, "finished")).resumeHint, "session_missing");
  await fresh.call("spawn", { cwd: repo, id: "finished", prompt: "plain", tools: [], durable: true });
  await settle(fresh, "finished");
  assert.equal((await read(fresh, "finished")).resumeHint, "session_missing", "a reused id is a different session");
  await close(fresh);
  fresh = await window();
  assert.equal((await read(fresh, "finished")).resumeHint, "session_missing", "also when only the catalog knows the new one");

  // 7. Saves in quick succession: the last one is the newest, even within one millisecond.
  await save(fresh, "finished", "quick-a");
  await save(fresh, "finished", "quick-b");
  assert.equal((await read(fresh)).handoff.name, "quick-b");
  await save(fresh, "finished", "quick-a");
  assert.equal((await read(fresh)).handoff.name, "quick-a", "saving again makes a note the newest");

  // read without a name returns the newest; a symlinked or trailing-slash cwd finds the same notes.
  await save(fresh, "finished", "newest");
  const newest = await read(fresh);
  assert.equal(newest.handoff.name, "newest");
  assert.ok(newest.names.includes("running") && newest.names.length === 8);
  await symlink(repo, join(directory, "repo-link"));
  assert.equal((await fresh.call("handoff", { action: "read", cwd: join(directory, "repo-link") + "/" })).handoff.name, "newest");
  const projectHistory = await fresh.call("sessions", { cwd: join(directory, "repo-link") + "/" });
  assert.ok([...projectHistory.sessions, ...projectHistory.stored].every((s) => s.cwd === canonicalRepo));
  await fresh.call("spawn", { cwd: repo, id: "exhausted", prompt: "plain", tools: [], durable: true, maxTurns: 1 });
  const exhausted = await settle(fresh, "exhausted");
  assert.deepEqual([exhausted.remainingTurns, exhausted.canFollowUp, exhausted.followUpBlockedReason], [0, false, "turn_budget_exhausted"]);
  await save(fresh, "exhausted", "exhausted");
  const spent = await read(fresh, "exhausted");
  assert.equal(spent.canFollowUp, false);
  assert.equal(spent.resumeHint, "status_then_spawn");
  assert.match(spent.howToResume, /spawn a new delegate/);
  await assert.rejects(() => fresh.call("follow_up", { sessionId: "exhausted", prompt: "again" }), /already used 1\/1 turns/);
  await assert.rejects(() => fresh.call("handoff", { action: "save", cwd: repo, sessionId: "finished" }), /needs sessionId, goal, completed and next/);
  // Two calls that load the same stored session at once both get it.
  await fresh.call("spawn", { cwd: repo, id: "twin", prompt: "plain", tools: [], durable: true });
  await settle(fresh, "twin");
  await close(fresh);
  const last = await window();
  const storedSpent = await read(last, "exhausted");
  assert.deepEqual([storedSpent.resumeHint, storedSpent.remainingTurns, storedSpent.canFollowUp], ["status_then_spawn", 0, false]);
  const twice = await Promise.allSettled([1, 2].map(() => last.call("follow_up", { sessionId: "twin", prompt: "again" })));
  const started = twice.filter((outcome) => outcome.status === "fulfilled");
  const refused = twice.filter((outcome) => outcome.status === "rejected");
  assert.equal(started.length, 1, "exactly one follow_up starts");
  assert.equal(refused.length, 1);
  assert.match(refused[0].reason.message, /Session twin is (starting|running)\. Use `steer`/);
  const twin = await settle(last, "twin");
  assert.equal(twin.turns, started[0].value.turnsSoFar + 1, "one follow-up turn, not two");
  await close(last);
  console.log("  OK -> handoff: memory-only warned, finished resumed, live owner respected, crash recovered, awaiting slot, id reuse, newest/named, cwd normalised");
} finally {
  for (const host of clients) await host.client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
