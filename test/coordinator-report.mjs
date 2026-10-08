import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { coordinatorSchema, createCoordinatorTools } from "../dist/coordinator.js";

const dir = await mkdtemp(join(tmpdir(), "pi-team-report-"));
const prompt = "PRIVATE PLAN PROMPT";
const body = "PRIVATE REPORT BODY";
const plan = (saveDir, count = 2) => coordinatorSchema.parse({
  ...(saveDir === undefined ? {} : { saveDir }),
  tasks: Array.from({ length: count }, (_, i) => ({ prompt, label: `task-${i}`, model: "requested/hint" })),
});
const call = async (tools, name, args = {}) =>
  (await tools.find((t) => t.name === name).execute("test", args)).structuredContent;
const index = async (receipt) => JSON.parse(await readFile(receipt.reportIndex, "utf8"));
const snapshot = (sessionId, extra = {}) => ({
  sessionId, state: "done", model: "actual/model", label: `label-${sessionId}`,
  lastText: body, questions: [], remainingTurns: 1, canFollowUp: true, ...extra,
});
const batch = (sessions, failures = []) => ({
  requested: sessions.length + failures.length, started: sessions.length,
  sessionIds: sessions.map((s) => s.sessionId), sessions,
  ...(failures.length ? { failed: failures.length, failures } : {}),
});
const summary = (sessions) => ({ settled: sessions.map((s) => s.sessionId), pending: [], continueIds: [], sessions });

try {
  const saveDir = join(dir, "reports");
  const oldReport = join(dir, "returned-original.md"); // deliberately not a guessed saveDir path
  await writeFile(oldReport, body);
  const states = new Map([
    ["a", snapshot("a", { savedTo: oldReport, savedChars: body.length })],
    ["b", snapshot("b", { state: "error", error: "child failed", saveError: "report write failed",
      termination: { reason: "max_turns", at: new Date().toISOString(), limit: 1, observed: 1 } })],
  ]);
  let starts = 0;
  let followPath;
  let delayedGet;
  let delayedWait;
  const getRequests = [];
  const core = {
    startBatch: async () => ++starts === 1
      ? batch([{ index: 0, sessionId: "a", state: "running", model: "actual/model-a" }], [{ index: 1, error: "construction failed" }])
      : batch([{ index: 0, sessionId: "b", state: "running", model: "actual/model-b" }]),
    waitForMany: async (ids) => delayedWait ? delayedWait.promise : summary(ids.map((id) => states.get(id))),
    getState: async (id) => {
      getRequests.push(id);
      if (delayedGet && id === "a") {
        const once = delayedGet;
        delayedGet = undefined; // only the old get is held; latest-snapshot refreshes must proceed
        return once.promise;
      }
      return states.get(id);
    },
    followUp: async (id, text, attachments, saveTo) => {
      assert.equal(text, "PRIVATE FOLLOW-UP PROMPT");
      assert.equal(attachments, undefined);
      followPath = saveTo;
      states.set(id, snapshot(id, { state: "running" }));
      return { sessionId: id, state: "running", turnsSoFar: 1 };
    },
  };
  const publications = [];
  const tools = createCoordinatorTools(plan(saveDir), dir, core, (fields) => publications.push(fields));
  assert.deepEqual(publications, [], "no publication before a flush");
  assert.ok(tools[0].description.includes("reportIndex"));
  await assert.rejects(readdir(saveDir), { code: "ENOENT" }); // no constructor IO
  const first = await call(tools, "delegate_start_batch", { taskIndexes: [1, 0] });
  assert.equal(first.started, 1);
  assert.equal(first.sessions[0].taskIndex, 1);
  assert.equal(first.failures[0].taskIndex, 0);
  assert.match(basename(first.reportIndex), /^team-[0-9a-f-]{36}\.json$/);
  let saved = await index(first);
  assert.deepEqual(publications.at(-1), { reportIndex: first.reportIndex }, "callback follows a completed write");
  assert.equal(saved.cwd, dir);
  assert.equal(basename(first.reportIndex), `team-${saved.teamId}.json`);
  assert.ok(Date.parse(saved.createdAt) && Date.parse(saved.updatedAt));
  assert.equal(saved.tasks[0].error, "construction failed");
  assert.equal(saved.tasks[0].sessionId, undefined);
  assert.equal(saved.tasks[1].model, "actual/model-a", "store actual model, not requested hint");
  assert.deepEqual(saved.tasks[1].reports, [], "a start receipt does not predict a report path");

  const retry = await call(tools, "delegate_start_batch", { taskIndexes: [0] });
  assert.equal(retry.reportIndex, first.reportIndex, "one index per team");
  // Parallel observations each write the whole merged projection, without losing siblings' metadata.
  await Promise.all([call(tools, "delegate_get", { sessionId: "a" }), call(tools, "delegate_get", { sessionId: "b" })]);
  saved = await index(first);
  const [b, a] = saved.tasks;
  assert.equal(a.sessionId, "a");
  assert.equal(a.taskIndex, 1);
  assert.equal(a.label, "label-a");
  assert.equal(a.model, "actual/model");
  assert.deepEqual(a.reports.map((r) => [r.version, r.savedTo]), [[0, oldReport]]);
  assert.equal(b.sessionId, "b");
  assert.equal(b.state, "error");
  assert.equal(b.error, "child failed");
  assert.equal(b.termination.reason, "max_turns");
  assert.equal(b.saveError, "report write failed");
  const getsBeforeWait = getRequests.length;
  const waited = await call(tools, "delegate_wait", { timeoutMs: 0 });
  assert.equal(getRequests.length, getsBeforeWait, "ordinary wait does not query extra snapshots");
  assert.equal(waited.reportIndex, first.reportIndex);
  assert.equal((await index(waited)).tasks[1].reports.length, 1, "repeat savedTo observations are deduplicated");

  // A late old get must not undo the successful follow-up receipt/current run's state.
  const oldGet = Promise.withResolvers();
  delayedGet = oldGet;
  const late = call(tools, "delegate_get", { sessionId: "a" });
  delayedWait = Promise.withResolvers();
  const acrossFollow = call(tools, "delegate_wait", { sessionIds: ["a"], timeoutMs: 0 });
  const follow = await call(tools, "delegate_follow_up", { sessionId: "a", prompt: "PRIVATE FOLLOW-UP PROMPT" });
  assert.equal(follow.nextAction, "wait");
  assert.equal(follow.reportIndex, first.reportIndex);
  saved = await index(follow);
  assert.equal(saved.tasks[1].followUpVersion, 1);
  assert.equal(saved.tasks[1].state, "running");
  assert.equal(saved.tasks[1].reports.length, 1, "do not index the requested follow-up path before a successful returned save");
  await writeFile(followPath, `${body} NEW`);
  states.set("a", snapshot("a", { savedTo: followPath, savedChars: body.length + 4 }));
  delayedWait.resolve(summary([states.get("a")]));
  await acrossFollow; // wait began before follow-up, but returned the new run's savedTo
  delayedWait = undefined;
  await call(tools, "delegate_wait", { timeoutMs: 0 });
  oldGet.resolve(snapshot("a", { state: "error", error: "stale error", savedTo: oldReport }));
  await late;
  saved = await index(first);
  assert.deepEqual(saved.tasks[1].reports.map((r) => [r.version, r.savedTo]), [[0, oldReport], [1, followPath]]);
  assert.equal(saved.tasks[1].state, "done");
  assert.equal(saved.tasks[1].error, undefined);
  assert.equal(saved.tasks[0].saveError, "report write failed", "follow-up preserves sibling metadata");
  assert.equal(await readFile(oldReport, "utf8"), body, "old report is preserved");
  assert.equal(await readFile(followPath, "utf8"), `${body} NEW`);
  const text = await readFile(first.reportIndex, "utf8");
  for (const secret of [prompt, body, "PRIVATE FOLLOW-UP PROMPT", "requested/hint"])
    assert.ok(!text.includes(secret), `index excludes sensitive full text/model hints: ${secret}`);

  const other = createCoordinatorTools(plan(saveDir, 1), dir, {
    startBatch: async () => batch([{ index: 0, sessionId: "other", state: "running", model: "actual/other" }]),
  });
  const second = await call(other, "delegate_start_batch");
  assert.notEqual(second.reportIndex, first.reportIndex);
  assert.notEqual((await index(second)).teamId, saved.teamId);
  assert.equal((await index(first)).tasks.length, 2, "another team does not overwrite this team");
  assert.deepEqual((await readdir(saveDir)).sort(), [basename(first.reportIndex), basename(second.reportIndex), basename(followPath)].sort());

  // A wait spanning a follow-up must refresh failures without savedTo, not leave the index running.
  for (const outcome of [
    { state: "error", error: "follow-up failed" },
    { state: "done", saveError: "follow-up report write failed" },
  ]) {
    const before = getRequests.length;
    delayedWait = Promise.withResolvers();
    const spanning = call(tools, "delegate_wait", { sessionIds: ["a", "b"], timeoutMs: 0 });
    await call(tools, "delegate_follow_up", { sessionId: "a", prompt: "PRIVATE FOLLOW-UP PROMPT" });
    const latest = snapshot("a", outcome);
    assert.equal(latest.savedTo, undefined);
    states.set("a", latest);
    const originalBatch = summary([latest, states.get("b")]);
    delayedWait.resolve(originalBatch);
    const returned = await spanning;
    delayedWait = undefined;
    assert.deepEqual(getRequests.slice(before), ["a"], "only the child with a changed version is refreshed");
    assert.deepEqual(returned.settled, originalBatch.settled);
    assert.equal(returned.sessions[0].state, outcome.state, "wait still returns its original batch");
    assert.equal(returned.sessions[0].error, outcome.error);
    assert.equal(returned.sessions[0].saveError, outcome.saveError);
    saved = await index(returned);
    assert.equal(saved.tasks[1].state, outcome.state);
    assert.equal(saved.tasks[1].error, outcome.error);
    assert.equal(saved.tasks[1].saveError, outcome.saveError);
    assert.equal(saved.tasks[1].reports.length, 2, "failed/unsaved follow-ups add no report refs");
    assert.equal(saved.tasks[0].error, "child failed", "refresh preserves the unchanged sibling");
  }

  // Filesystem failure after a successful core launch is diagnostic, not a retryable launch failure.
  const blocked = join(dir, "not-a-directory");
  await writeFile(blocked, "file blocks mkdir");
  let ioStarts = 0;
  const ioPublications = [];
  const failing = createCoordinatorTools(plan(blocked, 1), dir, {
    startBatch: async () => { ioStarts++; return batch([{ index: 0, sessionId: "io-child", state: "running", model: "actual/io" }]); },
    getState: async () => snapshot("io-child"),
    waitForMany: async () => summary([snapshot("io-child")]),
    followUp: async () => ({ sessionId: "io-child", state: "running" }),
  }, (fields) => ioPublications.push(fields));
  const failedIndex = await call(failing, "delegate_start_batch");
  assert.equal(failedIndex.started, 1);
  assert.deepEqual(failedIndex.sessionIds, ["io-child"]);
  assert.equal(typeof failedIndex.reportIndexError, "string");
  assert.equal(failedIndex.reportIndex, undefined);
  assert.equal((await call(failing, "delegate_start_batch")).started, 0);
  await assert.rejects(call(failing, "delegate_start_batch", { taskIndexes: [0] }), /already dispatched/);
  assert.equal(ioStarts, 1, "failed index IO never reopens dispatched membership");
  assert.equal(typeof (await call(failing, "delegate_wait", { timeoutMs: 0 })).reportIndexError, "string");
  assert.equal(typeof (await call(failing, "delegate_get", { sessionId: "io-child" })).reportIndexError, "string");
  assert.equal((await call(failing, "delegate_follow_up", { sessionId: "io-child", prompt: "question" })).nextAction, "wait");
  await rm(blocked);
  await mkdir(blocked);
  const recoveredIndex = await call(failing, "delegate_get", { sessionId: "io-child" });
  assert.equal((await index(recoveredIndex)).tasks[0].followUpVersion, 1, "IO failure does not lose in-memory metadata or poison the write chain");
  assert.deepEqual(ioPublications.at(-1), { reportIndex: recoveredIndex.reportIndex });
  await rm(blocked, { recursive: true });
  await writeFile(blocked, "block the previously successful publication");
  const failedAfterSuccess = await call(failing, "delegate_get", { sessionId: "io-child" });
  assert.equal(typeof ioPublications.at(-1).reportIndexError, "string");
  assert.equal(failedAfterSuccess.reportIndex, undefined, "internal tool does not claim the old publication succeeded again");
  await rm(blocked);
  const publishedAgain = await call(failing, "delegate_get", { sessionId: "io-child" });
  assert.deepEqual(ioPublications.at(-1), { reportIndex: recoveredIndex.reportIndex });
  assert.equal(publishedAgain.reportIndexError, undefined);

  const noSaveDir = join(dir, "memory-only");
  await mkdir(noSaveDir);
  const memory = createCoordinatorTools(plan(undefined, 1), noSaveDir, {
    startBatch: async () => batch([{ index: 0, sessionId: "memory-child", state: "running" }]),
    getState: async () => snapshot("memory-child"),
    waitForMany: async () => summary([snapshot("memory-child")]),
    followUp: async (_id, _prompt, _attachments, saveTo) => {
      assert.equal(saveTo, undefined);
      return { sessionId: "memory-child", state: "running" };
    },
  }, () => { throw new Error("no saveDir must not publish metadata"); });
  assert.ok(!memory[0].description.includes("reportIndex"), "default description has no index guidance");
  for (const [name, args] of [
    ["delegate_start_batch", {}], ["delegate_wait", { timeoutMs: 0 }],
    ["delegate_get", { sessionId: "memory-child" }], ["delegate_follow_up", { sessionId: "memory-child", prompt: "question" }],
    ["delegate_start_batch", {}],
  ]) {
    const value = await call(memory, name, args);
    assert.equal("reportIndex" in value, false);
    assert.equal("reportIndexError" in value, false);
  }
  assert.deepEqual(await readdir(noSaveDir), [], "no saveDir means no index/report IO");
  console.log("  OK -> coordinator report snapshots: partial failures, observed report versions, parallel merge, team isolation, nonfatal IO, opt-in only");
} finally {
  await rm(dir, { recursive: true, force: true });
}
