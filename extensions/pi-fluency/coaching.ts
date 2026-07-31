import { createHash } from "node:crypto";
import { selectedTargetForMistake } from "./analytics.js";
import { isGloballySnoozed } from "./practice-settings.js";
import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type AnalyzerMistake,
  type FluencySettings,
  type PracticePolicySnapshot,
  type PracticeSettings,
  type PracticeTarget,
} from "./types.js";

export const MAX_COACHING_MISTAKES = 3;

export interface CoachingEligibilityInput {
  source: string;
  idle: boolean;
  textOnly: boolean;
  collectionEligible: boolean;
  sessionSnoozed: boolean;
  now?: number;
  policy: PracticePolicySnapshot;
}

export type CoachingDecision = "edit" | "send-once" | "snooze-session" | "snooze-five-hours";
export type CoachingTerminalOutcome = "edit" | "continue";
export type AnalysisReuseAction = "commit-foreground" | "queue-background" | "discard";

export type CoachingRevalidation =
  | "unchanged"
  | "analytics-disabled"
  | "analyzer-changed"
  | "gate-changed";

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function canonicalTargets(targets: readonly PracticeTarget[]): Array<[string, string[]]> {
  return targets
    .map((target): [string, string[]] => [target.explanation, sorted(target.memberPatternKeys)])
    .sort(([left], [right]) => left.localeCompare(right));
}

/** Identity of output-affecting analyzer configuration. Built from request-scoped settings. */
export function analyzerResultFingerprint(settings: FluencySettings): string {
  return stableDigest({
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    provider: settings.provider ?? null,
    modelId: settings.modelId ?? null,
    minimumConfidence: settings.minimumConfidence,
  });
}

/** Identity of every policy value that can change whether coaching gates submission. */
export function gatePolicyFingerprint(
  snapshot: PracticePolicySnapshot,
  sessionSnoozed = false,
): string {
  return stableDigest({
    analyzer: analyzerResultFingerprint(snapshot.settings),
    analyticsEnabled: snapshot.settings.enabled,
    analyticsConsent: snapshot.settings.consentedAt ?? null,
    ignoredPatternKeys: sorted(snapshot.settings.ignoredPatternKeys),
    ignoredCategories: sorted(snapshot.settings.ignoredCategories),
    practiceRevision: snapshot.practice.revision,
    practiceEpoch: snapshot.practice.epoch,
    practiceEnabled: snapshot.practice.enabled,
    practiceConsent: snapshot.practice.consentedAt ?? null,
    snoozedUntil: snapshot.practice.snoozedUntil ?? null,
    targets: canonicalTargets(snapshot.practice.targets),
    sessionSnoozed,
  });
}

export function isAnalyticsPersistenceEnabled(settings: FluencySettings): boolean {
  return settings.enabled
    && typeof settings.consentedAt === "number"
    && Number.isFinite(settings.consentedAt)
    && typeof settings.provider === "string"
    && settings.provider.length > 0
    && typeof settings.modelId === "string"
    && settings.modelId.length > 0;
}

export function isCoachingEligible(input: CoachingEligibilityInput): boolean {
  const now = input.now ?? Date.now();
  const { settings, practice } = input.policy;
  return input.source === "interactive"
    && input.idle
    && input.textOnly
    && input.collectionEligible
    && !input.sessionSnoozed
    && isAnalyticsPersistenceEnabled(settings)
    && practice.enabled
    && typeof practice.consentedAt === "number"
    && Number.isFinite(practice.consentedAt)
    && practice.targets.length > 0
    && !isGloballySnoozed(practice, now);
}

/** Selected, non-ignored matches only. Complete result remains untouched for persistence. */
export function selectedCoachingMistakes(
  result: AnalysisResult,
  settings: FluencySettings,
  practice: PracticeSettings,
): AnalyzerMistake[] {
  const ignoredKeys = new Set(settings.ignoredPatternKeys);
  const ignoredCategories = new Set(settings.ignoredCategories);
  return result.mistakes.filter((mistake) => selectedTargetForMistake(
    mistake,
    practice.targets,
    ignoredKeys,
    ignoredCategories,
  ) !== undefined);
}

/** Stable bounded presentation; never mutates or truncates full analysis result. */
export function boundedCoachingMistakes(
  result: AnalysisResult,
  settings: FluencySettings,
  practice: PracticeSettings,
  maximum = MAX_COACHING_MISTAKES,
): AnalyzerMistake[] {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid coaching mistake limit");
  return selectedCoachingMistakes(result, settings, practice).slice(0, maximum);
}

/** Change-specific persistence/gating fallback after fresh policy reread. */
export function revalidateCoachingPolicy(
  before: PracticePolicySnapshot,
  after: PracticePolicySnapshot,
  beforeSessionSnoozed = false,
  afterSessionSnoozed = false,
): CoachingRevalidation {
  if (!isAnalyticsPersistenceEnabled(after.settings)) return "analytics-disabled";
  if (analyzerResultFingerprint(before.settings) !== analyzerResultFingerprint(after.settings)) {
    return "analyzer-changed";
  }
  if (gatePolicyFingerprint(before, beforeSessionSnoozed)
    !== gatePolicyFingerprint(after, afterSessionSnoozed)) return "gate-changed";
  return "unchanged";
}

/** Persistence handoff for terminal arbiter. Actual generation fence remains store-owned. */
export function analysisReuseAction(
  terminal: CoachingTerminalOutcome,
  revalidation: CoachingRevalidation,
): AnalysisReuseAction {
  if (terminal === "edit" || revalidation === "analytics-disabled") return "discard";
  if (revalidation === "analyzer-changed") return "queue-background";
  return "commit-foreground";
}
