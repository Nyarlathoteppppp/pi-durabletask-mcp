# answerState benchmark

Can Jev tell a usable conclusion (`complete`) from text that is not one (`narration`: announces or
plans work, reports progress without the result, asks the caller for information, or refuses)?
Only these two are judged by Jev; `missing` (empty text) and `partial` (cut off, aborted, error,
stalled) are decided by rules and are not part of this benchmark.

## Ground truth (frozen before any Jev run)

- 105 real final texts: 60 from Pi MCP delegate results in Claude Code transcripts (42 finished,
  18 mid-run texts), 45 turn-ending (`stopReason: "stop"`) assistant texts from the user's Pi sessions,
  sampled with a bias towards short or "Let me…/接下来…" openings.
- Labelled independently by Claude (Opus 5.5) and GPT-6.1 sol; 102 agreed, 3 disagreements
  (two steer probes answering "PINEAPPLE", one answer that also promised an undone action) dropped.
- 102 items: 73 complete, 29 narration. The texts are private (user sessions) and stay in
  `private/gt.json`, which is not committed. sha256 of that file:
  `d02f63066f2fa2fe03d9b8a80d268bbb405ea66e3f2784927c7ff54e3ec13a44`.
- Model input per item: the task's first 400 characters and the final text's last 1500.

Results are appended below; only aggregates are published.

## Run 1: development set (the 102 items above), 2026-10-06

`jev-latest` via TypeSafe, prompt as in `src/judge.ts`, 5 s timeout for measurement.

| threshold on Jev's probability | reported | wrong | narration caught |
|---|---|---|---|
| none (0.5) | 102 | 7 (4 complete called narration) | 26/29 |
| 0.7 | 93 | 3 | 26/29 |
| **0.8** | **88** | **1** | **26/29** |
| 0.9 | 81 | 1 | 23/29 |
| 0.95 | 69 | 0 | 22/29 |

Latency p50 about 250 ms, p95 about 300-400 ms; no failed calls. Of the 7 errors at 0.5, two
had no task text (a server always has one), two were mid-run texts with interim findings, and one
label looks wrong in hindsight (a progress report answering "how is it going?").

**Frozen policy (chosen on this set, to be confirmed on a held-out set):** report only problems.
`answerState: "narration"` when Jev says narration with probability >= 0.8; nothing when it says
complete, is less sure, or fails. `missing` and `partial` come from rules.
