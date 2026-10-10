/**
 * Provider notices that some routes deliver as an ordinary reply, without a stop reason: Gemini's safety
 * filter through Antigravity, for one. Exact openings only, so a real answer is never matched.
 */
export const PROVIDER_REFUSAL = /^This request was blocked by Gemini's filters\./;

export const LAST_TURN_PROMPT =
  "This is your last turn, and your tools have been removed. Answer now from the evidence already collected. " +
  "Follow the user's requested format and length. Preserve concrete findings and important limitations; " +
  "do not add unrequested sections.";

export const FINALIZE_PROMPT =
  "Stop expanding the investigation. Reserve one remaining turn for your final answer; use other " +
  "remaining turns only for essential checks needed to support your conclusion. Return the best conclusion from " +
  "the evidence already collected. Follow the user's requested format and length. Preserve concrete findings " +
  "and important limitations; do not add unrequested sections.";

export const FALLBACK_PROMPT =
  "The previous model stopped on a provider error. Continue the task from the conversation so far; " +
  "do not repeat completed work.";
