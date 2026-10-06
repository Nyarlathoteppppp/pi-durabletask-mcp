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
