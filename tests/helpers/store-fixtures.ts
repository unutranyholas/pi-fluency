import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FluencyStore } from "../../extensions/pi-fluency/store.js";
import type { ErrantErrorType } from "../../extensions/pi-fluency/taxonomy.js";
import type { AnalysisResult, CollectedPrompt } from "../../extensions/pi-fluency/types.js";

export const analysisResult: AnalysisResult = {
  schemaVersion: 3,
  language: "en",
  mistakes: [{
    original: "an parallel agent",
    correction: "a parallel agent",
    contextScope: "sentence",
    sourceExcerpt: "I want an parallel agent.",
    correctedExcerpt: "I want a parallel agent.",
    explanation: "Use a before a consonant sound.",
    errorType: "R:DET",
    patternKey: "grammar.articles.a-before-consonant",
    confidence: 0.98,
  }],
  demonstratedFixes: [],
};

export function resultFor(patternKey: string, errorType: ErrantErrorType = "R:DET"): AnalysisResult {
  return {
    ...analysisResult,
    mistakes: [{ ...analysisResult.mistakes[0]!, patternKey, errorType }],
  };
}

export function collected(
  promptHash: string,
  observedAt = 100,
  prose = "I want an parallel agent.",
): CollectedPrompt {
  return { promptHash, prose, observedAt };
}

export function historyAnalysis(
  promptHash: string,
  analysis: AnalysisResult = analysisResult,
  observedAt = 100,
) {
  return {
    schemaVersion: 4,
    type: "analysis",
    at: observedAt,
    prompt: collected(promptHash, observedAt),
    wordCount: 5,
    result: analysis,
  } as const;
}

export function observation(store: FluencyStore, promptHash: string) {
  return store.getAnalyticsSnapshot().observations.find((item) => item.promptHash === promptHash);
}

export function occurrences(store: FluencyStore) {
  return store.getAnalyticsSnapshot().occurrences;
}

export function patterns(store: FluencyStore) {
  return store.getAnalyticsSnapshot().patterns;
}

export type SnapshotMutator = (snapshot: unknown) => unknown;

export function replaceFirstSnapshotField(
  collection: string,
  field: string,
  value: unknown,
): SnapshotMutator {
  return (snapshot) => {
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      throw new Error("Invalid snapshot fixture");
    }
    const entries = (snapshot as Record<string, unknown>)[collection];
    if (!Array.isArray(entries) || typeof entries[0] !== "object" || entries[0] === null || Array.isArray(entries[0])) {
      throw new Error("Invalid snapshot fixture");
    }
    (entries[0] as Record<string, unknown>)[field] = value;
    return snapshot;
  };
}

export async function createStoreRoot(): Promise<{
  root: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-fluency-"));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
