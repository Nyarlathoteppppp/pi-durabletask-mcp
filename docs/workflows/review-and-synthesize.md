# Parallel review, then synthesize

This recipe uses existing tools. The caller supplies the scope and division of work;
there is no automatic planner or group runtime.

## 1. Launch scoped reviewers

Replace paths with absolute paths for your repository and a fresh output directory.
Omit `model` for the configured default, or choose actual IDs from `models` per task.

`spawn_batch`:

```json
{
  "cwd": "/absolute/repo",
  "saveDir": "/absolute/reports/review-01",
  "tools": ["read", "grep", "find", "ls"],
  "extensions": false,
  "nativeMcp": false,
  "mcpServers": [],
  "maxTurns": 10,
  "maxToolCalls": 12,
  "maxDurationMs": 240000,
  "tasks": [
    { "label": "recovery", "prompt": "Review src/durable.ts and recovery paths in src/pi/worker.ts for concrete correctness bugs. Read only. Report each finding with file:line, trigger, impact and evidence; distinguish confirmed facts from uncertainty. Do not invent stress scenarios. Finish with a concise report, including no findings if appropriate." },
    { "label": "attachments", "prompt": "Review src/attachments.ts and its call sites for concrete correctness bugs. Read only. Report each finding with file:line, trigger, impact and evidence; distinguish confirmed facts from uncertainty. Do not invent stress scenarios. Finish with a concise report, including no findings if appropriate." }
  ]
}
```

Have a settled **fact-gathering** session? Add `forkFrom` at batch or task level.
Keep explicit read-only tools. Children get fresh budgets. Shared history may contain
stale code or previous opinions; use current files for verification and keep independent
reviews independent. Forking does not guarantee cache hits or lower total input tokens.

## 2. Wait and retain the reports

Call `wait` with returned `sessionIds`, `until: "all_settled"`, `timeoutMs: 55000`.
Keep the returned snapshots; repeat with `continueIds` while work remains.
Answer pending questions with their real IDs before waiting again.

Collect each successful report's **returned `savedTo`**, not guessed filenames.
Also retain failed, aborted, missing-answer and `saveError` cases. A terminal state
or `nextAction: "finish"` does not establish success. If saving failed, surface it
and preserve the returned text; do not pass a nonexistent file as an attachment.

## 3. Synthesize without reprinting reports

Start a fresh `spawn` after reviewers finish. Populate `attachments` with the actual
`savedTo` values collected in step 2; the path below is only a placeholder to replace:

```json
{
  "cwd": "/absolute/repo",
  "attachments": ["/absolute/reports/review-01/returned-session-id.md"],
  "tools": [],
  "maxTurns": 4,
  "maxToolCalls": 1,
  "maxDurationMs": 180000,
  "prompt": "Synthesize the attached independent reviews. This is report synthesis, not independent source verification. Return: actionable findings with reviewer/session and file:line references; disagreements or findings raised by only one reviewer; missing evidence and failed coverage; a short recommendation. Do not treat agreement or vote count as proof. Preserve uncertainty. Keep it concise. Failed/aborted reviewers: [insert their IDs, scopes and reasons, or none]."
}
```

Attach all successfully saved reports (within the existing attachment limits).
Collect with `wait(until: "settled")`. Keep the final summary **and** every reviewer’s
session ID, scope, state and `savedTo`; the main agent verifies important findings.
If there are no usable reports, report incomplete coverage instead of inventing a synthesis.

A specific unresolved claim can receive a targeted `follow_up`; use remaining quotas
or pass `maxTurns`/`maxToolCalls` for fresh quotas, then refresh the report and summary.
Fork when changing model/tools or needing an independent branch. This step is optional,
not a required debate round. A [codemode coordinator](codemode-coordinator.md) can do
this itself with `delegate_follow_up` on its own children.

`durable: true` can retain individual delegates across restarts. This recipe itself is
caller-driven; it does not make the entire workflow automatically recoverable.
`maxToolCalls` limits tool use; `maxDurationMs` separately bounds each run's wall time.

For web research, use the [native research configuration](../research.md) and replace
each task's scope with a research question and required primary sources.
