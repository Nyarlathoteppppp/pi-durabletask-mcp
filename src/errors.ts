/** Errors reach us as `unknown`; this is the one place that decides how to read them. */
export function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

const BRIEF_ERROR = 200;

/**
 * A provider error short enough for a notice the caller reads on every wait. Gateways often send a
 * verbose JSON body; its own summary field replaces it. The final `error` keeps the full text.
 */
export function briefError(text: string): string {
  const body = text.indexOf("{");
  if (body >= 0) {
    try {
      const parsed = JSON.parse(text.slice(body)) as Record<string, unknown> & { error?: { message?: unknown } };
      const summary = [parsed.title, parsed.error?.message, parsed.message, parsed.detail, parsed.error]
        .find((value) => typeof value === "string" && value);
      if (summary) text = `${text.slice(0, body).trim()} ${summary}`;
    } catch { /* not a JSON body; clip as it is */ }
  }
  return text.length > BRIEF_ERROR ? `${text.slice(0, BRIEF_ERROR)}…` : text;
}
