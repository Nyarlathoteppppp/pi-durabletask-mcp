// Replays the frozen ground truth through the shipped judge (dist/judge.js) and prints aggregates.
// Per-item results go to private/, which is not committed.
// Usage: PI_DELEGATE_JUDGE_ENV_FILE=/path/.env node bench/answer-state/run.mjs [timeoutMs]
import { readFileSync, writeFileSync } from "node:fs";
import { classifyAnswer } from "../../dist/judge.js";

const here = new URL(".", import.meta.url).pathname;
const gt = JSON.parse(readFileSync(`${here}private/gt.json`, "utf8"));
const timeoutMs = Number(process.argv[2] ?? 5000);
await classifyAnswer("warm-up", "OK", timeoutMs); // cold start is slower than steady state
const results = [];
for (let i = 0; i < gt.length; i += 4) {
  results.push(...await Promise.all(gt.slice(i, i + 4).map(async (item) => {
    const started = performance.now();
    const r = await classifyAnswer(item.task, item.finalText, timeoutMs);
    return { id: item.id, label: item.label, got: r?.choice, p: r?.p, ms: Math.round(performance.now() - started) };
  })));
}
writeFileSync(`${here}private/results-${Date.now()}.json`, JSON.stringify(results, null, 1));
const count = (f) => results.filter(f).length;
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
const summary = {
  n: results.length, failed: count((r) => r.got === undefined),
  accuracy: +(count((r) => r.got === r.label) / results.length).toFixed(3),
  narrationRecall: `${count((r) => r.label === "narration" && r.got === "narration")}/${count((r) => r.label === "narration")}`,
  completeRecall: `${count((r) => r.label === "complete" && r.got === "complete")}/${count((r) => r.label === "complete")}`,
  falseNarration: count((r) => r.label === "complete" && r.got === "narration"),
  p50ms: ms[Math.floor(ms.length / 2)], p95ms: ms[Math.floor(ms.length * 0.95)],
};
console.log(JSON.stringify(summary));
// Reported only at or above a probability threshold; below it the field is omitted.
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  const kept = results.filter((r) => r.got !== undefined && r.p >= t);
  const wrong = kept.filter((r) => r.got !== r.label);
  console.log(JSON.stringify({ threshold: t, reported: kept.length, wrong: wrong.length,
    wrongNarration: wrong.filter((r) => r.got === "narration").length,
    narrationCaught: `${kept.filter((r) => r.label === "narration" && r.got === "narration").length}/${count((r) => r.label === "narration")}` }));
}
