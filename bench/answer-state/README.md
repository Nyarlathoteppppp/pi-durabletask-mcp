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

`jev-latest` via TypeSafe, prompt as in `judge.mjs`, 5 s timeout for measurement.

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

## Held-out set (frozen before evaluating the policy)

59 further turn-ending texts from the user's Pi sessions, none used above, sampled at random with
16 of them biased towards short or "Let me…/接下来…" openings. Labelled independently by Claude and
GPT-6.1 sol; 58 agreed (55 complete, 3 narration), 1 dropped (an answer that also promised an undone
action). sha256 of `private/heldout.json`: `648775a3203bb50e4014cb9e43cbecdfc6318de8b589bc2ae08c49e244ad937e`.

## Run 2: held-out set, frozen policy, 2026-10-06

| threshold | reported | wrong | narration caught |
|---|---|---|---|
| 0.5 | 58 | 4 (3 complete called narration) | 2/3 |
| **0.8 (frozen)** | **46** | **1** | **1/3** |
| 0.95 | 36 | 0 | 1/3 |

Under the frozen policy the server would have reported `narration` twice: one correct ("I'll split
Apple utterance tracking…", p 0.99) and one false (a short status note that was in fact the
conclusion: "the sub-review is already folded into the report, no new findings", p 0.85). A real
narration ("接着改选择器、组合根和 Home 文案。") scored only 0.65, and a refusal was called complete.
Latency p50 237 ms, p95 275 ms, no failed calls.

**Conclusion: not shipped.** On a realistic mix, where narration is rare, one false alarm per true
catch is not the "certain and clearly useful" bar this server applies to Jev. 0.95 had no errors on
either set, but it was not chosen in advance; using it needs a third held-out set, frozen first.

A rerun of the development set after moving the judge into this folder gave 0.922 instead of 0.931:
one item flipped. Jev's answers vary slightly between identical calls.
