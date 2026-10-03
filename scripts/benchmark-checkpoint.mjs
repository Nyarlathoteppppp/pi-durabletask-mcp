import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const directory = await mkdtemp(join(tmpdir(), "pi-checkpoint-bench-"));
process.env.PI_OFFLINE = "1";
process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
process.env.PI_DELEGATE_STATE_DIR = join(directory, "state");
await mkdir(process.env.PI_CODING_AGENT_DIR);
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { DurableJob } = await import("../dist/durable.js");
const { PiWorker } = await import("../dist/pi/worker.js");
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const stats = values => ({ medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95) });
const cases = [];
const iterations = 30;
const warmup = 3;
try {
  for (const mib of [0.1, 1, 5]) {
    const worker = new PiWorker({ cwd: directory, tools: [], maxTurns: 100, maxDurationMs: 60000 });
    const manager = SessionManager.inMemory(directory);
    manager.appendMessage({ role: "user", content: "x".repeat(Math.round(mib * 1024 * 1024)), timestamp: 1 });
    const checkpoint = { phase: "execute", entries: [manager.getHeader(), ...manager.getEntries()],
      snapshot: worker.snapshot({ verbose: true }), inputStarted: true, results: {}, steering: [] };
    const job = await DurableJob.open({ id: `benchmark-${mib}`, cwd: directory, tools: [],
      maxTurns: 100, maxDurationMs: 60000 }, "benchmark");
    let started, finish;
    const ready = new Promise(resolve => { started = resolve; });
    const release = new Promise(resolve => { finish = resolve; });
    const { done } = await job.begin("benchmark", checkpoint, async () => {
      started();
      await release;
      return checkpoint;
    });
    try {
      await ready; // save() must run inside a live task, otherwise it is a no-op.
      const save = async () => {
        checkpoint.snapshot.turns++;
        const start = performance.now();
        await job.save(checkpoint);
        return performance.now() - start;
      };
      for (let i = 0; i < warmup; i++) await save();
      const saves = [], clones = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        JSON.parse(JSON.stringify(checkpoint));
        clones.push(performance.now() - start);
        saves.push(await save());
      }
      const persisted = await job.saved();
      if (persisted.snapshot.turns !== warmup + iterations) throw new Error("Benchmark did not commit checkpoints");
      cases.push({ payloadBytes: Buffer.byteLength(JSON.stringify(checkpoint)), clone: stats(clones), save: stats(saves) });
    } finally {
      finish();
      await done;
      await job.forget();
    }
  }
  console.log(JSON.stringify({ node: process.version, iterations, warmup,
    workload: "single worker; fixed synthetic payload; real DurableJob.save and SQLite; save includes clone cost", cases }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
