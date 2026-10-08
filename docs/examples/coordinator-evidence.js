// Run after coordinator.js, in the same coordinator. Change focus to your specific question.
// @options: {"max_output_tokens": 2000}
const focus = /recovery|ownership/i;
const dispatch = load("team.dispatch") ?? await tools.delegate_wait({ timeoutMs: 0 });
const ids = dispatch.sessionIds ?? dispatch.sessions.map(s => s.sessionId);
const reports = await Promise.allSettled(ids.map(sessionId => tools.delegate_get({ sessionId })));
const evidence = reports.map((result, index) => {
  if (result.status === "rejected") return { sessionId: ids[index], error: String(result.reason) };
  const report = result.value;
  const lines = report.lastText.split("\n");
  return {
    sessionId: report.sessionId, label: report.label, state: report.state,
    savedTo: report.savedTo, error: report.error, answerState: report.answerState,
    questions: report.questions, canFollowUp: report.canFollowUp,
    // Mechanical text matching, not a relevance or correctness judgement. Originals remain authoritative.
    excerpts: lines.flatMap((text, i) => focus.test(text) ? [{ line: i + 1, text }] : []),
    totalLines: lines.length,
  };
});
store("team.evidence", evidence); // Small references/excerpts, not complete report bodies.
return { evidence, dispatchFailures: dispatch.failures ?? [], note: "Filtered excerpts; inspect originals for other findings or missing context." };
