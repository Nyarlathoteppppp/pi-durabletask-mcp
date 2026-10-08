// A later script in the SAME session. Stored values are not visible to the model until emitted.
const evidence = load("team.evidence");
if (!evidence) return { error: "No evidence ledger; collect reports first." };
return evidence.map(item => ({
  sessionId: item.sessionId, label: item.label, state: item.state,
  savedTo: item.savedTo, error: item.error, answerState: item.answerState,
  questions: item.questions, excerpts: item.excerpts,
}));
// Read a savedTo report or request delegate_get when the excerpts are insufficient.
