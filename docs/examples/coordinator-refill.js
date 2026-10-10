// Optional script: a plan larger than the free slots. Instead of waiting for the slowest child of
// each batch, start the next task as soon as any child settles. SLOTS is how many children this
// coordinator may run at once: the server limit minus its own slot and any other work.
// Run it again, unchanged, to continue after answering questions; progress is kept in store.
const TASKS = [0, 1, 2, 3, 4, 5]; // plan indexes, in launch order
const SLOTS = 3;
const saved = load("refill") ?? { next: 0, running: [], finished: [] };
let next = saved.next;
const running = new Set(saved.running);
const finished = [...saved.finished];
let questions = [];
const launch = async () => {
  while (next < TASKS.length && running.size < SLOTS) {
    // A full server rejects or fails the launch; the index stays unlaunched and is retried later.
    // An index started by an earlier failed script is skipped; delegate_wait({timeoutMs:0}) lists its child.
    const batch = await tools.delegate_start_batch({ taskIndexes: [TASKS[next]] }).catch((error) => ({ error: String(error) }));
    if (batch.error?.includes("already dispatched")) { next++; continue; }
    if (!batch.started) break;
    batch.sessionIds.forEach(id => running.add(id));
    next++;
  }
};
await launch();
for (let round = 0; running.size && round < 20; round++) {
  const waited = await tools.delegate_wait({ sessionIds: [...running], until: "settled", timeoutMs: 55000 });
  // settled also lists children waiting for an answer; only those absent from continueIds finished.
  for (const id of waited.settled) {
    if (!waited.continueIds.includes(id)) { running.delete(id); finished.push(id); }
  }
  // A question needs the caller: return it rather than keep waiting on a child that cannot move.
  questions = waited.sessions.filter(s => s.pendingQuestions);
  if (questions.length) break;
  await launch();
}
store("refill", { next, running: [...running], finished });
return { finished, running: [...running], unlaunched: TASKS.slice(next), questions };
// Read finished reports with delegate_get before synthesizing.
