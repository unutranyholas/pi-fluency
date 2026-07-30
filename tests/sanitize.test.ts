import { describe, expect, it } from "vitest";
import {
  sanitizeAnalyzerField,
  sanitizeCollectedInput,
  sanitizePersistedFinding,
  sanitizeTerminalLabel,
  stripTerminalSequences,
} from "../extensions/pi-fluency/sanitize.js";

describe("terminal sanitization policies", () => {
  it.each([
    ["safe\u001b[31m text", "safe text"],
    ["safe\u009b31m text", "safe text"],
    ["safe\u001b]0;secret title\u0007 text", "safe text"],
    ["safe\u0000\u0007\u001b text", "safe text"],
  ])("strips terminal payloads consistently from %j", (input, expected) => {
    expect(stripTerminalSequences(input)).toBe(expected);
    expect(sanitizeAnalyzerField(input)).toBe(expected);
    expect(sanitizePersistedFinding(input, 500)).toBe(expected);
    expect(sanitizeTerminalLabel(input)).toBe(expected);
  });

  it("preserves text whitespace only for collection before code stripping", () => {
    const input = "line one\n\tline two\r\nline three\u0000";
    expect(sanitizeCollectedInput(input)).toBe("line one\n\tline two\r\nline three");
    expect(stripTerminalSequences(input)).toBe("line oneline twoline three");
  });

  it("keeps analyzer trimming policy separate from terminal-label policy", () => {
    expect(sanitizeAnalyzerField("  spaced  ")).toBe("  spaced  ");
    expect(sanitizeTerminalLabel("  spaced  ")).toBe("spaced");
    expect(sanitizeAnalyzerField("", false)).toBeUndefined();
    expect(sanitizeAnalyzerField("", true)).toBe("");
  });

  it("enforces independent bounded-field limits", () => {
    expect(sanitizeAnalyzerField("x".repeat(501))).toBeUndefined();
    expect(sanitizePersistedFinding("x".repeat(6), 5)).toBeUndefined();
    expect(sanitizeTerminalLabel("x".repeat(6), 5)).toBe("xxxxx");
  });
});
