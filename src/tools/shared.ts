/** Every tool answers with pretty JSON, so a human reading the transcript can follow it. */
export const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
