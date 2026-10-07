// Optional: verify one specific claim after the initial review, not a debate round.
// Run in the SAME coordinator session that ran coordinator.js; choose the relevant child yourself.
const previous = load("team.reports")[0];
const started = await tools.delegate_follow_up({
  sessionId: previous.sessionId,
  prompt: "Verify the specific claim [insert claim] against current source. Return file:line and evidence, or retract it.",
  maxTurns: 3,
  maxToolCalls: 2,
});
const waited = await tools.delegate_wait({ sessionIds: [started.sessionId], timeoutMs: 55000 });
const updated = await tools.delegate_get({ sessionId: started.sessionId });
store("team.verification", { previous, updated });
return { sessionId: updated.sessionId, state: updated.state, savedTo: updated.savedTo,
  continueIds: waited.continueIds, questions: updated.questions };
// Keep waiting if needed, then refresh updated before synthesizing. Original reports remain available.
