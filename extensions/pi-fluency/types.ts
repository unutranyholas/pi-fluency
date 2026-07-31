import type { ErrantCategory, ErrantErrorType } from "./taxonomy.js";

export const SETTINGS_SCHEMA_VERSION = 3 as const;
export const HISTORY_SCHEMA_VERSION = 4 as const;
export const SCHEMA_VERSION = SETTINGS_SCHEMA_VERSION;
export const ANALYSIS_SCHEMA_VERSION = 3 as const;
export const PRACTICE_SCHEMA_VERSION = 1 as const;

export interface CollectedPrompt {
  promptHash: string;
  prose: string;
  observedAt: number;
}

export type ContextScope = "sentence" | "previous-and-current" | "current-and-next";

export interface RawAnalyzerMistake {
  original: string;
  correction: string;
  contextScope: ContextScope;
  explanation: string;
  errorType: ErrantErrorType;
  patternKey: string;
  confidence: number;
}

export interface AnalyzerMistake extends RawAnalyzerMistake {
  sourceExcerpt: string;
  correctedExcerpt: string;
}

export interface DemonstratedFix {
  patternKey: string;
  evidence: string;
  confidence: number;
}

export type AnalysisLanguage = "en" | "other";

export interface RawAnalysisResult {
  schemaVersion: typeof ANALYSIS_SCHEMA_VERSION;
  language: AnalysisLanguage;
  mistakes: RawAnalyzerMistake[];
  demonstratedFixes: DemonstratedFix[];
}

export interface AnalysisResult {
  schemaVersion: typeof ANALYSIS_SCHEMA_VERSION;
  language: AnalysisLanguage;
  mistakes: AnalyzerMistake[];
  demonstratedFixes: DemonstratedFix[];
}

export type OccurrenceDecision = "pending" | "accepted" | "dismissed";

export interface EnglishObservation {
  promptHash: string;
  observedAt: number;
  localDate: string;
  wordCount: number;
  occurrenceIds: string[];
}

export interface MistakeOccurrence {
  id: string;
  promptHash: string;
  patternId: string;
  patternKey: string;
  observedAt: number;
  localDate: string;
  decision: OccurrenceDecision;
}

export interface FluencyAnalyticsSnapshot {
  observations: EnglishObservation[];
  occurrences: MistakeOccurrence[];
  patterns: MistakePattern[];
  ignoredPatternKeys: string[];
  ignoredCategories: ErrantCategory[];
}

export interface MistakePattern {
  id: string;
  patternKey: string;
  original: string;
  correction: string;
  sourceExcerpt: string;
  correctedExcerpt: string;
  explanation: string;
  errorType: ErrantErrorType;
  confidence: number;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  demonstratedFixCount: number;
}

export type SnapshotPattern = MistakePattern;

export interface ReviewPattern extends MistakePattern {
  pendingCount: number;
  acceptedCount: number;
  dismissedCount: number;
}

export interface FluencySettings {
  schemaVersion: typeof SCHEMA_VERSION;
  enabled: boolean;
  consentedAt?: number;
  provider?: string;
  modelId?: string;
  minimumConfidence: number;
  retentionLimit: number;
  ignoredPatternKeys: string[];
  ignoredCategories: ErrantCategory[];
}

export const DEFAULT_SETTINGS: FluencySettings = {
  schemaVersion: SCHEMA_VERSION,
  enabled: false,
  minimumConfidence: 0.8,
  retentionLimit: 500,
  ignoredPatternKeys: [],
  ignoredCategories: [],
};

export interface PracticeTarget {
  explanation: string;
  memberPatternKeys: string[];
}

export interface PracticeSettings {
  schemaVersion: typeof PRACTICE_SCHEMA_VERSION;
  revision: number;
  epoch: number;
  enabled: boolean;
  consentedAt?: number;
  targets: PracticeTarget[];
  snoozedUntil?: number;
}

export interface PracticePolicySnapshot {
  settings: FluencySettings;
  practice: PracticeSettings;
}

export const DEFAULT_PRACTICE_SETTINGS: PracticeSettings = {
  schemaVersion: PRACTICE_SCHEMA_VERSION,
  revision: 0,
  epoch: 0,
  enabled: false,
  targets: [],
};

type HistoryEventBase = { schemaVersion: typeof HISTORY_SCHEMA_VERSION; at: number };

export type FluencyEvent =
  | (HistoryEventBase & { type: "analysis"; prompt: CollectedPrompt; wordCount: number; result: AnalysisResult })
  | (HistoryEventBase & { type: "review"; occurrenceIds: string[]; decision: Exclude<OccurrenceDecision, "pending"> })
  | (HistoryEventBase & { type: "snapshot"; patterns: SnapshotPattern[]; observations: EnglishObservation[]; occurrences: MistakeOccurrence[]; processedPromptHashes: string[] });

export interface FluencyState {
  patterns: Map<string, MistakePattern>;
  observations: Map<string, EnglishObservation>;
  occurrences: Map<string, MistakeOccurrence>;
  processedPromptHashes: Set<string>;
}
