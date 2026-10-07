// Optional script: caller-defined plans, no automatic planner. taskIndexes can select a subset.
const batch = await tools.delegate_start_batch({});
store("team.dispatch", batch);
const waited = await tools.delegate_wait({ sessionIds: batch.sessionIds, timeoutMs: 55000 });
// Catch separately: one unavailable report must not discard successful store writes.
const reports = await Promise.allSettled(
  batch.sessionIds.map(sessionId => tools.delegate_get({ sessionId }))
);
store("team.reports", reports.map((r, index) => r.status === "fulfilled"
  ? r.value
  : { sessionId: batch.sessionIds[index], error: String(r.reason) }));
return {
  dispatchFailures: batch.failures || [],
  continueIds: waited.continueIds,
  sessions: waited.sessions, // compact states/questions/savedTo, no report bodies
};
// When continueIds remain, wait again before treating text as final; answer pending questions.
// Later: load("team.reports") for synthesis. Refresh pending reports with delegate_get first.
