const TERMINAL_ESCAPE_SEQUENCE = /(?:\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\))/g;
const TERMINAL_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const TERMINAL_CONTROLS_EXCEPT_TEXT_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function stripTerminalSequences(value: string, preserveTextWhitespace = false): string {
  return value
    .replace(TERMINAL_ESCAPE_SEQUENCE, "")
    .replace(preserveTextWhitespace ? TERMINAL_CONTROLS_EXCEPT_TEXT_WHITESPACE : TERMINAL_CONTROLS, "");
}

/** Preserve line structure until code blocks and inline code have been removed. */
export function sanitizeCollectedInput(value: string): string {
  return stripTerminalSequences(value, true);
}

/** Validate one model-returned field without changing meaningful whitespace. */
export function sanitizeAnalyzerField(
  value: unknown,
  allowEmpty = false,
  maximumLength = 500,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = stripTerminalSequences(value);
  return (allowEmpty || sanitized.length > 0) && sanitized.length <= maximumLength ? sanitized : undefined;
}

/** Sanitize one finding field before it crosses the durable state boundary. */
export function sanitizePersistedFinding(
  value: unknown,
  maximumLength: number,
  allowEmpty = true,
): string | undefined {
  return sanitizeAnalyzerField(value, allowEmpty, maximumLength);
}

/** Remove terminal payloads, trim, and bound labels or user-visible error detail. */
export function sanitizeTerminalLabel(value: unknown, maximumLength = 500): string {
  if (typeof value !== "string") return "";
  return stripTerminalSequences(value).trim().slice(0, maximumLength);
}
