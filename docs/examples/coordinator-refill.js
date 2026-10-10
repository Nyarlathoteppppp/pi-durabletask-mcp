// Optional script: a plan larger than the free slots. Instead of waiting for the slowest child of
// each batch, start the next task as soon as any child settles. SLOTS is how many children this
// coordinator may run at once: the server limit minus its own slot and any other work.
const TASKS = [0, 1, 2, 3, 4, 5]; // plan indexes, in launch order
const SLOTS = 3;
let next = 0;
const running = new Set();
const finished = [];
const launch = async () => {
  while (next < TASKS.length && running.size < SLOTS) {
    // A full server rejects or fails the launch; the index stays unlaunched and is retried later.
    const batch = await tools.delegate_start_batch({ taskIndexes: [TASKS[next]] }).catch(() => undefined);
    if (!batch?.started) break;
    batch.sessionIds.forEach(id => running.add(id));
    next++;
  }
};
await launch();
for (let round = 0; running.size && round < 20; round++) {
  const waited = await tools.delegate_wait({ sessionIds: [...running], until: "settled", timeoutMs: 55000 });
  // A child asking a question has not finished: return so the caller can answer it.
  if (waited.sessions.some(s => s.pendingQuestions)) break;
  for (const id of waited.settled) { running.delete(id); finished.push(id); }
  await launch();
}
store("refill.finished", finished);
return { finished, running: [...running], unlaunched: TASKS.slice(next) };
// When running or unlaunched remain, run the script again with TASKS set to the unlaunched indexes
// and wait on the running ones; read reports with delegate_get before synthesizing.
