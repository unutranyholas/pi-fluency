import { isErrantErrorType } from "./taxonomy.js";
import {
  HISTORY_SCHEMA_VERSION,
  type AnalysisResult,
  type AnalyzerMistake,
  type ContextScope,
  type DemonstratedFix,
  type EnglishObservation,
  type FluencyEvent,
  type MistakeOccurrence,
  type SnapshotPattern,
} from "./types.js";

const EVENT_TYPES = new Set(["analysis", "review", "snapshot"]);
const CONTEXT_SCOPES = new Set<ContextScope>(["sentence", "previous-and-current", "current-and-next"]);
const PATTERN_KEY = /^[a-z]+(?:[.-][a-z0-9]+)+$/;

export class HistorySchemaMismatchError extends Error {
  constructor() {
    super("Unsupported fluency history schema");
    this.name = "HistorySchemaMismatchError";
  }
}

function invalid(): never {
  throw new Error("Invalid schema-v4 history event");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) return invalid();
  return value;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return invalid();
  return value;
}

function timestamp(value: unknown): number {
  const decoded = finite(value);
  if (!Number.isFinite(new Date(decoded).getTime())) return invalid();
  return decoded;
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return invalid();
  return value;
}

function confidence(value: unknown): number {
  const decoded = finite(value);
  if (decoded < 0 || decoded > 1) return invalid();
  return decoded;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return invalid();
  const decoded = value.map((item) => text(item));
  if (new Set(decoded).size !== decoded.length) return invalid();
  return decoded;
}

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function localDate(value: unknown): string {
  if (!isLocalDate(value)) return invalid();
  return value;
}

function decodeMistake(value: unknown): AnalyzerMistake {
  const candidate = record(value);
  const contextScope = text(candidate.contextScope);
  if (!CONTEXT_SCOPES.has(contextScope as ContextScope)) return invalid();
  const errorType = text(candidate.errorType);
  if (!isErrantErrorType(errorType)) return invalid();
  const patternKey = text(candidate.patternKey);
  if (!PATTERN_KEY.test(patternKey)) return invalid();
  return {
    original: text(candidate.original),
    correction: text(candidate.correction, true),
    contextScope: contextScope as ContextScope,
    sourceExcerpt: text(candidate.sourceExcerpt),
    correctedExcerpt: text(candidate.correctedExcerpt, true),
    explanation: text(candidate.explanation),
    errorType,
    patternKey,
    confidence: confidence(candidate.confidence),
  };
}

function decodeFix(value: unknown): DemonstratedFix {
  const candidate = record(value);
  const patternKey = text(candidate.patternKey);
  if (!PATTERN_KEY.test(patternKey)) return invalid();
  return {
    patternKey,
    evidence: candidate.evidence === undefined ? "" : text(candidate.evidence),
    confidence: confidence(candidate.confidence),
  };
}

function decodeAnalysisResult(value: unknown): AnalysisResult {
  const candidate = record(value);
  if (candidate.schemaVersion !== 3 || (candidate.language !== "en" && candidate.language !== "other")) return invalid();
  if (!Array.isArray(candidate.mistakes) || !Array.isArray(candidate.demonstratedFixes)) return invalid();
  const mistakes = candidate.mistakes.map(decodeMistake);
  const demonstratedFixes = candidate.demonstratedFixes.map(decodeFix);
  if (candidate.language === "other" && (mistakes.length > 0 || demonstratedFixes.length > 0)) return invalid();
  return { schemaVersion: 3, language: candidate.language, mistakes, demonstratedFixes };
}

function decodePattern(value: unknown): SnapshotPattern {
  const candidate = record(value);
  const errorType = text(candidate.errorType);
  if (!isErrantErrorType(errorType)) return invalid();
  const patternKey = text(candidate.patternKey);
  if (!PATTERN_KEY.test(patternKey)) return invalid();
  return {
    id: text(candidate.id),
    patternKey,
    original: text(candidate.original),
    correction: text(candidate.correction, true),
    sourceExcerpt: text(candidate.sourceExcerpt),
    correctedExcerpt: text(candidate.correctedExcerpt, true),
    explanation: text(candidate.explanation),
    errorType,
    confidence: confidence(candidate.confidence),
    firstSeenAt: timestamp(candidate.firstSeenAt),
    lastSeenAt: timestamp(candidate.lastSeenAt),
    occurrenceCount: nonnegativeInteger(candidate.occurrenceCount),
    demonstratedFixCount: nonnegativeInteger(candidate.demonstratedFixCount),
  };
}

function decodeObservation(value: unknown): EnglishObservation {
  const candidate = record(value);
  return {
    promptHash: text(candidate.promptHash),
    observedAt: timestamp(candidate.observedAt),
    localDate: localDate(candidate.localDate),
    wordCount: nonnegativeInteger(candidate.wordCount),
    occurrenceIds: stringArray(candidate.occurrenceIds),
  };
}

function decodeOccurrence(value: unknown): MistakeOccurrence {
  const candidate = record(value);
  if (candidate.decision !== "pending" && candidate.decision !== "accepted" && candidate.decision !== "dismissed") return invalid();
  return {
    id: text(candidate.id),
    promptHash: text(candidate.promptHash),
    patternId: text(candidate.patternId),
    patternKey: text(candidate.patternKey),
    observedAt: timestamp(candidate.observedAt),
    localDate: localDate(candidate.localDate),
    decision: candidate.decision,
  };
}

function decodeAnalysis(candidate: Record<string, unknown>): FluencyEvent {
  const prompt = record(candidate.prompt);
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    type: "analysis",
    at: timestamp(candidate.at),
    prompt: {
      promptHash: text(prompt.promptHash),
      observedAt: timestamp(prompt.observedAt),
      prose: prompt.prose === undefined ? "" : text(prompt.prose, true),
    },
    wordCount: nonnegativeInteger(candidate.wordCount),
    result: decodeAnalysisResult(candidate.result),
  };
}

function decodeReview(candidate: Record<string, unknown>): FluencyEvent {
  if (candidate.decision !== "accepted" && candidate.decision !== "dismissed") return invalid();
  const occurrenceIds = stringArray(candidate.occurrenceIds);
  if (occurrenceIds.length === 0) return invalid();
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    type: "review",
    at: timestamp(candidate.at),
    occurrenceIds,
    decision: candidate.decision,
  };
}

function decodeSnapshot(candidate: Record<string, unknown>): FluencyEvent {
  if (
    !Array.isArray(candidate.patterns)
    || !Array.isArray(candidate.observations)
    || !Array.isArray(candidate.occurrences)
  ) return invalid();
  const patterns = candidate.patterns.map(decodePattern);
  const observations = candidate.observations.map(decodeObservation);
  const occurrences = candidate.occurrences.map(decodeOccurrence);
  const processedPromptHashes = stringArray(candidate.processedPromptHashes);

  const patternById = new Map(patterns.map((pattern) => [pattern.id, pattern]));
  const observationByHash = new Map(observations.map((observation) => [observation.promptHash, observation]));
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  if (
    patternById.size !== patterns.length
    || observationByHash.size !== observations.length
    || occurrenceById.size !== occurrences.length
  ) return invalid();

  for (const observation of observations) {
    for (const id of observation.occurrenceIds) {
      const occurrence = occurrenceById.get(id);
      if (!occurrence || occurrence.promptHash !== observation.promptHash) return invalid();
    }
  }
  for (const occurrence of occurrences) {
    const suffix = occurrence.id.slice(occurrence.promptHash.length + 1);
    const observation = observationByHash.get(occurrence.promptHash);
    const pattern = patternById.get(occurrence.patternId);
    if (
      !occurrence.id.startsWith(`${occurrence.promptHash}:`)
      || !/^\d+$/.test(suffix)
      || !observation?.occurrenceIds.includes(occurrence.id)
      || occurrence.observedAt !== observation.observedAt
      || occurrence.localDate !== observation.localDate
      || pattern?.patternKey !== occurrence.patternKey
    ) return invalid();
  }
  if (
    observations.some((observation) => !processedPromptHashes.includes(observation.promptHash))
  ) return invalid();

  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    type: "snapshot",
    at: timestamp(candidate.at),
    patterns,
    observations,
    occurrences,
    processedPromptHashes,
  };
}

export function decodeHistoryLine(value: unknown): FluencyEvent {
  const candidate = record(value);
  if (candidate.schemaVersion !== HISTORY_SCHEMA_VERSION) throw new HistorySchemaMismatchError();
  if (typeof candidate.type !== "string" || !EVENT_TYPES.has(candidate.type)) return invalid();
  if (candidate.type === "analysis") return decodeAnalysis(candidate);
  if (candidate.type === "review") return decodeReview(candidate);
  return decodeSnapshot(candidate);
}

export function encodeHistoryEvent(event: FluencyEvent): string {
  return JSON.stringify(event, (key, value) =>
    key === "prose" || key === "evidence"
      ? undefined
      : value);
}
