import { createHash } from "node:crypto";
import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type AnalyzerMistake,
  type EnglishObservation,
  type FluencyEvent,
  type FluencyState,
  type MistakeOccurrence,
  type MistakePattern,
  type SnapshotPattern,
} from "./types.js";
import { sanitizePersistedFinding } from "./sanitize.js";

function safeText(value: string): string {
  const sanitized = sanitizePersistedFinding(value, Number.POSITIVE_INFINITY);
  if (sanitized === undefined) throw new Error("Invalid persisted finding");
  return sanitized;
}

function patternId(patternKey: string): string {
  return createHash("sha256").update(patternKey.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid observation timestamp");
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeMistake(mistake: AnalyzerMistake): AnalyzerMistake {
  return {
    ...mistake,
    original: safeText(mistake.original),
    correction: safeText(mistake.correction),
    sourceExcerpt: safeText(mistake.sourceExcerpt),
    correctedExcerpt: safeText(mistake.correctedExcerpt),
    explanation: safeText(mistake.explanation),
    patternKey: safeText(mistake.patternKey),
  };
}

export function copyPattern(pattern: MistakePattern | SnapshotPattern): MistakePattern {
  return {
    ...pattern,
    original: safeText(pattern.original),
    correction: safeText(pattern.correction),
    sourceExcerpt: safeText(pattern.sourceExcerpt),
    correctedExcerpt: safeText(pattern.correctedExcerpt),
    explanation: safeText(pattern.explanation),
    patternKey: safeText(pattern.patternKey),
  };
}

export function copyAnalysisResult(result: AnalysisResult): AnalysisResult {
  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    language: result.language,
    mistakes: result.mistakes.map(normalizeMistake),
    demonstratedFixes: result.demonstratedFixes.map((fix) => ({
      ...fix,
      patternKey: safeText(fix.patternKey),
      evidence: safeText(fix.evidence),
    })),
  };
}

export function copyObservation(observation: EnglishObservation): EnglishObservation {
  return { ...observation, occurrenceIds: [...observation.occurrenceIds] };
}

export function copyOccurrence(occurrence: MistakeOccurrence): MistakeOccurrence {
  return { ...occurrence };
}

export function createFluencyState(): FluencyState {
  return {
    patterns: new Map(),
    observations: new Map(),
    occurrences: new Map(),
    processedPromptHashes: new Set(),
  };
}

export function replaceFluencyState(target: FluencyState, source: FluencyState): void {
  target.patterns.clear();
  target.observations.clear();
  target.occurrences.clear();
  target.processedPromptHashes.clear();
  for (const [id, pattern] of source.patterns) target.patterns.set(id, copyPattern(pattern));
  for (const [hash, observation] of source.observations) target.observations.set(hash, copyObservation(observation));
  for (const [id, occurrence] of source.occurrences) target.occurrences.set(id, copyOccurrence(occurrence));
  for (const hash of source.processedPromptHashes) target.processedPromptHashes.add(hash);
}

export function reduceHistoryEvent(state: FluencyState, event: FluencyEvent): void {
  if (event.type === "snapshot") {
    state.patterns.clear();
    state.observations.clear();
    state.occurrences.clear();
    state.processedPromptHashes.clear();
    for (const pattern of event.patterns) state.patterns.set(pattern.id, copyPattern(pattern));
    for (const observation of event.observations) {
      state.observations.set(observation.promptHash, copyObservation(observation));
    }
    for (const occurrence of event.occurrences) state.occurrences.set(occurrence.id, copyOccurrence(occurrence));
    for (const hash of event.processedPromptHashes) state.processedPromptHashes.add(hash);
    return;
  }
  if (event.type === "review") {
    if (event.occurrenceIds.some((id) => !state.occurrences.has(id))) {
      throw new Error("Invalid review event reference");
    }
    for (const id of event.occurrenceIds) {
      const occurrence = state.occurrences.get(id);
      if (occurrence?.decision === "pending") state.occurrences.set(id, { ...occurrence, decision: event.decision });
    }
    return;
  }

  const promptHash = event.prompt.promptHash;
  if (state.processedPromptHashes.has(promptHash)) return;
  const observedAt = event.prompt.observedAt;
  const result = copyAnalysisResult(event.result);
  if (result.language === "other") {
    state.processedPromptHashes.add(promptHash);
    return;
  }

  const localDate = localDateKey(observedAt);
  state.processedPromptHashes.add(promptHash);
  const occurrenceIds: string[] = [];
  for (const [index, mistake] of result.mistakes.entries()) {
    const id = patternId(mistake.patternKey);
    const current = state.patterns.get(id);
    state.patterns.set(id, current ? {
      ...current,
      original: mistake.original,
      correction: mistake.correction,
      explanation: mistake.explanation,
      sourceExcerpt: mistake.sourceExcerpt,
      correctedExcerpt: mistake.correctedExcerpt,
      errorType: mistake.errorType,
      confidence: Math.max(current.confidence, mistake.confidence),
      lastSeenAt: observedAt,
      occurrenceCount: current.occurrenceCount + 1,
    } : {
      id,
      patternKey: mistake.patternKey,
      original: mistake.original,
      correction: mistake.correction,
      sourceExcerpt: mistake.sourceExcerpt,
      correctedExcerpt: mistake.correctedExcerpt,
      explanation: mistake.explanation,
      errorType: mistake.errorType,
      confidence: mistake.confidence,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      occurrenceCount: 1,
      demonstratedFixCount: 0,
    });

    const occurrenceId = `${promptHash}:${index}`;
    occurrenceIds.push(occurrenceId);
    state.occurrences.set(occurrenceId, {
      id: occurrenceId,
      promptHash,
      patternId: id,
      patternKey: mistake.patternKey,
      observedAt,
      localDate,
      decision: "pending",
    });
  }

  state.observations.set(promptHash, {
    promptHash,
    observedAt,
    localDate,
    wordCount: event.wordCount,
    occurrenceIds,
  });

  for (const fix of result.demonstratedFixes) {
    const id = patternId(fix.patternKey);
    const current = state.patterns.get(id);
    if (current) state.patterns.set(id, { ...current, demonstratedFixCount: current.demonstratedFixCount + 1 });
  }
}
