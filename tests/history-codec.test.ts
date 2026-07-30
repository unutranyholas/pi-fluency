import { describe, expect, it } from "vitest";
import {
  HistorySchemaMismatchError,
  decodeHistoryLine,
  encodeHistoryEvent,
  isLocalDate,
} from "../extensions/pi-fluency/history-codec.js";
import type { FluencyEvent } from "../extensions/pi-fluency/types.js";

const mistake = {
  original: "an agent",
  correction: "an agent",
  contextScope: "sentence" as const,
  sourceExcerpt: "an agent",
  correctedExcerpt: "an agent",
  explanation: "Use an before a vowel sound.",
  errorType: "R:DET" as const,
  patternKey: "grammar.articles.vowel-sound",
  confidence: 0.9,
};

const analysis: FluencyEvent = {
  schemaVersion: 4,
  type: "analysis",
  at: 1,
  prompt: { promptHash: "hash", observedAt: 1, prose: "private prompt" },
  wordCount: 2,
  result: {
    schemaVersion: 3,
    language: "en",
    mistakes: [mistake],
    demonstratedFixes: [{ patternKey: mistake.patternKey, evidence: "private evidence", confidence: 0.9 }],
  },
};

const snapshot: FluencyEvent = {
  schemaVersion: 4,
  type: "snapshot",
  at: Date.UTC(2026, 6, 26),
  patterns: [{
    id: "pattern-1",
    patternKey: mistake.patternKey,
    original: mistake.original,
    correction: mistake.correction,
    sourceExcerpt: mistake.sourceExcerpt,
    correctedExcerpt: mistake.correctedExcerpt,
    explanation: mistake.explanation,
    errorType: mistake.errorType,
    confidence: mistake.confidence,
    firstSeenAt: 1,
    lastSeenAt: 1,
    occurrenceCount: 1,
    demonstratedFixCount: 0,
  }],
  observations: [{
    promptHash: "hash",
    observedAt: 1,
    localDate: "2026-07-26",
    wordCount: 2,
    occurrenceIds: ["hash:0"],
  }],
  occurrences: [{
    id: "hash:0",
    promptHash: "hash",
    patternId: "pattern-1",
    patternKey: mistake.patternKey,
    observedAt: 1,
    localDate: "2026-07-26",
    decision: "pending",
  }],
  processedPromptHashes: ["hash"],
};

describe("schema-v4 history codec", () => {
  it("rejects pre-v4 and unversioned history distinctly", () => {
    expect(() => decodeHistoryLine({ schemaVersion: 3, type: "snapshot", at: 1 }))
      .toThrow(HistorySchemaMismatchError);
    expect(() => decodeHistoryLine({ type: "analysis", at: 1 }))
      .toThrow(HistorySchemaMismatchError);
  });

  it("round-trips current events while replacing omitted private fields", () => {
    const decoded = decodeHistoryLine(JSON.parse(encodeHistoryEvent(analysis)) as unknown);
    expect(decoded).toMatchObject({
      schemaVersion: 4,
      type: "analysis",
      prompt: { promptHash: "hash", observedAt: 1, prose: "" },
      result: { demonstratedFixes: [{ patternKey: mistake.patternKey, evidence: "", confidence: 0.9 }] },
    });
    expect(decodeHistoryLine(JSON.parse(encodeHistoryEvent(snapshot)) as unknown)).toEqual(snapshot);
  });

  it.each([
    { schemaVersion: 4, type: "future", at: 1 },
    { ...analysis, at: Number.NaN },
    { ...analysis, at: 1e308 },
    { ...analysis, prompt: { ...analysis.prompt, observedAt: 1e308 } },
    { ...analysis, prompt: { promptHash: "", observedAt: 1 } },
    { ...analysis, wordCount: -1 },
    { ...analysis, result: { ...analysis.result, language: "other", mistakes: [mistake] } },
    { ...analysis, result: { ...analysis.result, mistakes: [{ ...mistake, errorType: "R:NOT_REAL" }] } },
    { schemaVersion: 4, type: "review", at: 1, occurrenceIds: [3], decision: "accepted" },
    { schemaVersion: 4, type: "review", at: 1, occurrenceIds: ["hash:0"], decision: "pending" },
    { schemaVersion: 4, type: "state", at: 1, patternId: "pattern-1", state: "future" },
    { ...snapshot, patterns: [{ ...snapshot.patterns[0]!, occurrenceCount: -1 }] },
    { ...snapshot, patterns: [{ ...snapshot.patterns[0]!, firstSeenAt: 1e308 }] },
    { ...snapshot, patterns: [{ ...snapshot.patterns[0]!, lastSeenAt: 1e308 }] },
    { ...snapshot, observations: [{ ...snapshot.observations[0]!, observedAt: 1e308 }] },
    { ...snapshot, observations: [{ ...snapshot.observations[0]!, localDate: "2026-02-30" }] },
    { ...snapshot, observations: [{ ...snapshot.observations[0]!, occurrenceIds: ["missing:0"] }] },
    { ...snapshot, occurrences: [{ ...snapshot.occurrences[0]!, observedAt: 1e308 }] },
    { ...snapshot, occurrences: [{ ...snapshot.occurrences[0]!, id: "wrong:0" }] },
    { ...snapshot, occurrences: [{ ...snapshot.occurrences[0]!, patternId: "missing" }] },
    { ...snapshot, processedPromptHashes: [] },
  ])("rejects malformed schema-v4 event %#", (value) => {
    expect(() => decodeHistoryLine(value)).toThrow("Invalid schema-v4 history event");
  });

  it.each([
    ["2024-02-29", true],
    ["2026-02-29", false],
    ["2026-02-30", false],
    ["2026-13-01", false],
    ["2026-07-26", true],
  ])("validates real local calendar date %s", (value, expected) => {
    expect(isLocalDate(value)).toBe(expected);
  });

  it("omits prompt prose and demonstrated-fix evidence when encoding", () => {
    const encoded = encodeHistoryEvent(analysis);
    expect(encoded).toContain('"schemaVersion":4');
    expect(encoded).not.toContain("private prompt");
    expect(encoded).not.toContain("private evidence");
  });
});
