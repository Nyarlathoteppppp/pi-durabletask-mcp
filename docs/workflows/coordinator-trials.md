# Three live coordinated reviews

On 2026-10-07, we reviewed this repository using a fresh built MCP process and the
current Codex host configuration. Each trial used a neutral fact session, two
`forkFrom` reviewers and one codemode coordinator. All six reviewers actually called
Exa search and fetch. Models: Pi Codex 6.1 Sol, direct DeepSeek Flash and Antigravity
Gemini 3.8 Flash; no OpenRouter. Each coordinator used a different one of these models.

| Scope | Facts + review + synthesis | Coordinator waits | Original report characters | Summary characters | Search/fetch calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ownership and retention | 85 s | 2 | 2219 | 2129 | 6 |
| Attachments and secret paths | 95 s | 2 | 2425 | 792 | 8 |
| Coordinator and native MCP | 87 s | 2 | 3285 | 1885 | 4 |

Character counts are JavaScript string lengths, not tokens. Timings include the fact
session; network latency and provider behavior are uncontrolled. The attachment
originals include a provider refusal, not two complete reviews.

## What we verified

- **One bug found and fixed:** `forgetOwnedJob` deleted its catalog row, then failed
  to release ownership if directory removal threw. The orphan sweep skipped that
  locally owned directory indefinitely. A tiny injected `EACCES` regression failed
  before the fix and passed after adding `finally`; a subsequent sweep removes it.
- **Two retention claims rejected:** retiring catalog-free lock tombstones is not
  deleting a live job's mutex; global storage pressure intentionally scans finished,
  unowned jobs across agent directories. Neither claim established an execution bug.
- **Attachment coverage incomplete:** Gemini returned a filter refusal. DeepSeek
  labelled short reads and path replacement as unverified and decoder reuse as an
  evidence gap. These are not counted as confirmed defects. The host separately
  reviewed the existing guards and ran attachment/workspace checks. A direct
  invalid-UTF-8-then-valid-Chinese attachment check also disproved decoder
  contamination for that sequence; no guard was added for it.
- **Research integration worked:** opt-in children received the exact Exa pair;
  installed SDK source and integration tests support the permission boundaries.
  The reviewer surfaced wording issues in wait/store documentation, now clarified.

The coordinator preserved actionable findings, uncertainty and failed coverage when
compared with the saved originals. It did not independently verify findings, and
reviewer agreement was not used as proof. There is no known-bug baseline here, so
we cannot measure recall, missing bugs or an accuracy improvement.

## Caller effort and waiting

The normal path was five MCP calls per trial: spawn facts, wait for facts, spawn
coordinator, then two waits for the coordinator. No child bodies were rewritten by
the caller. Extra `status(verbose)` and `sessions` calls collected validation evidence;
they are excluded from that five-call workflow, but were real experiment overhead.

The first coordinator wait timed out at 55 seconds with `phase: tool` and about
51–53 seconds of idle time. That is expected while codemode awaits children, not
evidence of a hung model. A second wait completed. Final saved-result responses were
403, 1215 and 394 compact JSON characters; longer summaries were referenced by file.
The caller must still read a saved summary before accepting its conclusions.

## Practical adjustments

- Give code-plus-research reviewers enough budget: these trials used 16 turns and
  14 own tool calls. An initial smaller-budget pilot exhausted one branch without
  an answer. This is a caller choice, not a new enforced runtime default.
- Ask for specific primary-source sections. Broad fetches of large documentation
  pages sometimes returned the table of contents or truncated before the needed
  section; successful browsing does not guarantee useful evidence.
- Keep original reports and a concise synthesis. One summary was nearly as long as
  its originals: orchestration avoids manual transport but does not guarantee token
  savings. There is no single-agent or caller-orchestrated cost/quality baseline.
- A settled fact session reduces repeated setup, but reviewers may still re-read
  files. They should decide which checks need fresh evidence.

An initial pilot used an outdated Pi-host model policy instead of the current Codex
host policy and blocked a Codex child. Correcting the experiment configuration fixed
that setup error; no production model policy or automatic fallback was changed.
