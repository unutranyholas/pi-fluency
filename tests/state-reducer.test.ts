import { describe, expect, it } from "vitest";
import {
  copyAnalysisResult,
  createFluencyState,
  reduceHistoryEvent,
} from "../extensions/pi-fluency/state-reducer.js";
import type { AnalysisResult, FluencyEvent } from "../extensions/pi-fluency/types.js";

const result: AnalysisResult = {
  schemaVersion: 3,
  language: "en",
  mistakes: [{
    original: "an\u001b[31m parallel",
    correction: "a parallel",
    contextScope: "sentence",
    sourceExcerpt: "an parallel",
    correctedExcerpt: "a parallel",
    explanation: "Use a before a consonant sound.",
    errorType: "R:DET",
    patternKey: "grammar.articles.a-before-consonant",
    confidence: 0.9,
  }],
  demonstratedFixes: [],
};

function analysis(promptHash: string, value: AnalysisResult = result): FluencyEvent {
  return {
    schemaVersion: 4,
    type: "analysis",
    at: 100,
    prompt: { promptHash, observedAt: 100, prose: "" },
    wordCount: 4,
    result: value,
  };
}

describe("fluency state reducer", () => {
  it("reduces English analysis into one observation, occurrence, and normalized pattern", () => {
    const state = createFluencyState();
    reduceHistoryEvent(state, analysis("hash-1"));

    expect(state.processedPromptHashes).toEqual(new Set(["hash-1"]));
    expect(state.observations.get("hash-1")).toMatchObject({ wordCount: 4, occurrenceIds: ["hash-1:0"] });
    expect(state.occurrences.get("hash-1:0")).toMatchObject({ decision: "pending", patternKey: result.mistakes[0]!.patternKey });
    expect([...state.patterns.values()][0]).toMatchObject({ original: "an parallel", occurrenceCount: 1 });
  });

  it("ignores a duplicate prompt event without changing counts", () => {
    const state = createFluencyState();
    reduceHistoryEvent(state, analysis("same"));
    reduceHistoryEvent(state, analysis("same"));
    expect([...state.patterns.values()][0]?.occurrenceCount).toBe(1);
    expect(state.occurrences.size).toBe(1);
  });

  it("rejects an invalid typed observation timestamp before mutating state", () => {
    const state = createFluencyState();
    const event = analysis("invalid-date") as Extract<FluencyEvent, { type: "analysis" }>;
    event.prompt.observedAt = 1e308;
    expect(() => reduceHistoryEvent(state, event)).toThrow("Invalid observation timestamp");
    expect(state.processedPromptHashes).toEqual(new Set());
  });

  it("records only the processed hash for non-English analysis", () => {
    const state = createFluencyState();
    reduceHistoryEvent(state, analysis("other", {
      schemaVersion: 3,
      language: "other",
      mistakes: [],
      demonstratedFixes: [],
    }));
    expect(state.processedPromptHashes).toEqual(new Set(["other"]));
    expect(state.observations.size).toBe(0);
    expect(state.patterns.size).toBe(0);
  });

  it("validates every review reference before changing any decision", () => {
    const state = createFluencyState();
    reduceHistoryEvent(state, analysis("review"));
    expect(() => reduceHistoryEvent(state, {
      schemaVersion: 4,
      type: "review",
      at: 200,
      occurrenceIds: ["review:0", "missing:0"],
      decision: "accepted",
    })).toThrow("Invalid review event reference");
    expect(state.occurrences.get("review:0")?.decision).toBe("pending");
  });

  it("replaces accumulated state with a snapshot", () => {
    const state = createFluencyState();
    reduceHistoryEvent(state, analysis("old"));
    reduceHistoryEvent(state, {
      schemaVersion: 4,
      type: "snapshot",
      at: 300,
      patterns: [],
      observations: [],
      occurrences: [],
      processedPromptHashes: ["retained"],
    });
    expect(state.patterns.size).toBe(0);
    expect(state.observations.size).toBe(0);
    expect(state.processedPromptHashes).toEqual(new Set(["retained"]));
  });

  it("copies analyzer results without exposing aliases", () => {
    const copied = copyAnalysisResult(result);
    copied.mistakes[0]!.original = "mutated";
    expect(result.mistakes[0]!.original).toContain("\u001b[31m");
  });
});
