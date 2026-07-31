import { createHash } from "node:crypto";
import { errantCategory } from "./taxonomy.js";
import type {
  EnglishObservation,
  MistakeOccurrence,
  MistakePattern,
  PracticeAnalysisContext,
  PracticeMistakeCandidate,
  PracticeTarget,
  ResolvedPracticeTarget,
} from "./types.js";
import type { ErrantCategory } from "./taxonomy.js";

const ENGLISH_WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const SPARK_GLYPHS = "▁▂▃▄▅▆▇█";
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TREND_DAYS = 30;
const MAX_KNOWN_PATTERNS = 500;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** Count word-like runs after the analyzer has classified sanitized prose as English. */
export function countEnglishWords(prose: string): number {
  return [...prose.matchAll(ENGLISH_WORD)].length;
}

export type RuleTrend = "improving" | "worsening" | "stable" | "new";

export interface RuleAnalytics {
  patternId: string;
  /** Deterministic UI identity derived from explanation; never persist or render it. */
  rowKey: string;
  explanation: string;
  /** Complete current group membership for durable selection. Never render it. */
  memberPatternKeys: string[];
  accepted: number;
  ratePerThousand: number | undefined;
  sparkline: string;
  trend: RuleTrend;
  changePercent?: number;
}

export interface FluencyAnalytics {
  pendingOccurrences: number;
  periodPendingOccurrences: number;
  activeRules: number;
  currentRatePerThousand?: number;
  periodRatePerThousand?: number;
  toolbarSparkline: string;
  englishWords: number;
  accepted: number;
  dismissed: number;
  oneOffAccepted: number;
  reviewCoverage?: number;
  rules: RuleAnalytics[];
  trendCounts: Record<RuleTrend, number>;
}

export interface AnalyticsInput {
  observations: Iterable<EnglishObservation>;
  occurrences: Iterable<MistakeOccurrence>;
  patterns: Iterable<MistakePattern>;
  ignoredPatternKeys: ReadonlySet<string>;
  ignoredCategories: ReadonlySet<ErrantCategory>;
  now: number;
}

export function ratePerThousand(accepted: number, words: number): number | undefined {
  return words > 0 ? accepted * 1_000 / words : undefined;
}

export function renderSparkline(values: Array<number | undefined>): string {
  const finite = values.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return values.map(() => "·").join("");
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  return values.map((value) => {
    if (value === undefined || !Number.isFinite(value)) return "·";
    if (minimum === maximum) return maximum === 0 ? SPARK_GLYPHS[0]! : SPARK_GLYPHS[3]!;
    const index = Math.round((value - minimum) / (maximum - minimum) * (SPARK_GLYPHS.length - 1));
    return SPARK_GLYPHS[Math.max(0, Math.min(SPARK_GLYPHS.length - 1, index))]!;
  }).join("");
}

export function classifyRuleTrend(
  current: number | undefined,
  previous: number | undefined,
): RuleTrend {
  if (current === undefined || !Number.isFinite(current) || current <= 0) {
    if (previous === undefined || !Number.isFinite(previous) || previous <= 0) return "stable";
  }
  if (current !== undefined && Number.isFinite(current) && current > 0
    && (previous === undefined || !Number.isFinite(previous) || previous <= 0)) return "new";
  if (current === undefined || previous === undefined || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return "stable";
  }
  const absolute = Math.abs(current - previous);
  const relative = previous > 0 ? absolute / previous : 0;
  if (absolute < 0.5 || relative < 0.2) return "stable";
  return current < previous ? "improving" : "worsening";
}

function localDateKey(now: number): string {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function within(localDate: string, start: string, end: string): boolean {
  return DATE_KEY.test(localDate) && localDate >= start && localDate <= end;
}

interface WindowTotals {
  words: number;
  accepted: number;
  dismissed: number;
}

interface RuleGroup {
  patternId: string;
  explanation: string;
  patternIds: Set<string>;
  memberPatternKeys: Set<string>;
}

function assertValidTarget(target: PracticeTarget): void {
  if (target.explanation.length === 0 || target.explanation.length > 500
    || CONTROL_CHARACTER.test(target.explanation)
    || target.memberPatternKeys.length === 0 || target.memberPatternKeys.length > 500
    || target.memberPatternKeys.some((key) => key.length === 0 || key.length > 500 || CONTROL_CHARACTER.test(key))) {
    throw new Error("Invalid practice target");
  }
}

function copyTarget(target: PracticeTarget): PracticeTarget {
  assertValidTarget(target);
  return { explanation: target.explanation, memberPatternKeys: [...target.memberPatternKeys] };
}

/** Stable transient identity for a concrete rule row. Never persist or display this value. */
export function practiceRuleRowKey(explanation: string): string {
  if (explanation.length === 0 || explanation.length > 500 || CONTROL_CHARACTER.test(explanation)) {
    throw new Error("Invalid practice target");
  }
  return `rule-${createHash("sha256").update(explanation).digest("hex").slice(0, 16)}`;
}

export interface ResolvePracticeTargetsInput {
  targets: readonly PracticeTarget[];
  patterns: readonly MistakePattern[];
  ignoredPatternKeys: ReadonlySet<string>;
  ignoredCategories: ReadonlySet<ErrantCategory>;
}

/** Project durable selections against current patterns without mutating either input. */
export function resolvePracticeTargets(input: ResolvePracticeTargetsInput): ResolvedPracticeTarget[] {
  return input.targets.map((target) => {
    assertValidTarget(target);
    const durableKeys = new Set(target.memberPatternKeys);
    const current = input.patterns.filter((pattern) =>
      durableKeys.has(pattern.patternKey) || pattern.explanation === target.explanation);
    const currentByKey = new Map(current.map((pattern) => [pattern.patternKey, pattern]));
    const memberPatternKeys = [...new Set([
      ...target.memberPatternKeys,
      ...current.map((pattern) => pattern.patternKey),
    ])].sort((left, right) => left.localeCompare(right));
    const coachingEnabled = memberPatternKeys.some((patternKey) => {
      if (input.ignoredPatternKeys.has(patternKey)) return false;
      const pattern = currentByKey.get(patternKey);
      return pattern === undefined || !input.ignoredCategories.has(errantCategory(pattern.errorType));
    });
    return {
      rowKey: practiceRuleRowKey(target.explanation),
      explanation: target.explanation,
      memberPatternKeys,
      currentPatternKeys: [...new Set(current.map((pattern) => pattern.patternKey))]
        .sort((left, right) => left.localeCompare(right)),
      coachingEnabled,
    };
  });
}

/** Return matching selected target unless candidate is suppressed by Ignore policy. */
export function selectedTargetForMistake(
  candidate: PracticeMistakeCandidate,
  targets: readonly PracticeTarget[],
  ignoredPatternKeys: ReadonlySet<string>,
  ignoredCategories: ReadonlySet<ErrantCategory>,
): PracticeTarget | undefined {
  for (const target of targets) assertValidTarget(target);
  if (CONTROL_CHARACTER.test(candidate.explanation) || CONTROL_CHARACTER.test(candidate.patternKey)) {
    throw new Error("Invalid practice candidate");
  }
  if (ignoredPatternKeys.has(candidate.patternKey)
    || ignoredCategories.has(errantCategory(candidate.errorType))) return undefined;
  const target = targets.find((item) =>
    item.explanation === candidate.explanation || item.memberPatternKeys.includes(candidate.patternKey));
  return target === undefined ? undefined : copyTarget(target);
}

function comparePatternRecency(left: MistakePattern, right: MistakePattern): number {
  return right.lastSeenAt - left.lastSeenAt
    || left.patternKey.localeCompare(right.patternKey)
    || left.id.localeCompare(right.id);
}

/** Prioritize selected patterns while keeping complete target descriptors outside bounded context. */
export function selectPracticeAnalysisContext(
  targets: readonly PracticeTarget[],
  patterns: readonly MistakePattern[],
  maximumPatterns = MAX_KNOWN_PATTERNS,
): PracticeAnalysisContext {
  if (!Number.isSafeInteger(maximumPatterns) || maximumPatterns < 0) {
    throw new Error("Invalid known pattern limit");
  }
  const targetDescriptors = targets.map(copyTarget);
  const selected: MistakePattern[] = [];
  const selectedIds = new Set<string>();
  for (const target of targetDescriptors) {
    const memberKeys = new Set(target.memberPatternKeys);
    const matches = patterns
      .filter((pattern) => memberKeys.has(pattern.patternKey) || pattern.explanation === target.explanation)
      .sort(comparePatternRecency);
    for (const pattern of matches) {
      if (selectedIds.has(pattern.id)) continue;
      selectedIds.add(pattern.id);
      selected.push(pattern);
    }
  }
  const remaining = patterns
    .filter((pattern) => !selectedIds.has(pattern.id))
    .sort(comparePatternRecency);
  return {
    targetDescriptors,
    patterns: [...selected, ...remaining].slice(0, maximumPatterns),
  };
}

export function computeFluencyAnalytics(input: AnalyticsInput): FluencyAnalytics {
  const observations = [...input.observations];
  const occurrences = [...input.occurrences];
  const patterns = [...input.patterns];
  const today = localDateKey(input.now);
  const patternsById = new Map(patterns.map((pattern) => [pattern.id, pattern]));

  const isIgnored = (occurrence: MistakeOccurrence): boolean => {
    const pattern = patternsById.get(occurrence.patternId);
    if (input.ignoredPatternKeys.has(pattern?.patternKey ?? occurrence.patternKey)) return true;
    return pattern !== undefined && input.ignoredCategories.has(errantCategory(pattern.errorType));
  };

  const totals = (end: string, days: number): WindowTotals => {
    const start = shiftDate(end, -(days - 1));
    return {
      words: observations
        .filter((observation) => within(observation.localDate, start, end))
        .reduce((sum, observation) => sum + Math.max(0, observation.wordCount), 0),
      accepted: occurrences.filter((occurrence) =>
        occurrence.decision === "accepted" && within(occurrence.localDate, start, end)).length,
      dismissed: occurrences.filter((occurrence) =>
        occurrence.decision === "dismissed" && within(occurrence.localDate, start, end)).length,
    };
  };

  const trailingRates = Array.from({ length: 7 }, (_, index) => {
    const end = shiftDate(today, index - 6);
    const window = totals(end, 7);
    return ratePerThousand(window.accepted, window.words);
  });
  const currentSeven = totals(today, 7);
  const currentThirty = totals(today, TREND_DAYS);
  const previousEnd = shiftDate(today, -TREND_DAYS);
  const previousThirty = totals(previousEnd, TREND_DAYS);
  const currentStart = shiftDate(today, -(TREND_DAYS - 1));

  const visiblePending = occurrences.filter((occurrence) =>
    occurrence.decision === "pending" && !isIgnored(occurrence));
  const visiblePendingInPeriod = visiblePending.filter((occurrence) =>
    within(occurrence.localDate, currentStart, today)).length;
  const reviewed = currentThirty.accepted + currentThirty.dismissed;
  const reviewable = reviewed + visiblePendingInPeriod;

  const groupsByExplanation = new Map<string, RuleGroup>();
  for (const pattern of patterns) {
    const explanation = pattern.explanation;
    const existing = groupsByExplanation.get(explanation);
    if (existing) {
      existing.patternIds.add(pattern.id);
      existing.memberPatternKeys.add(pattern.patternKey);
      if (pattern.id.localeCompare(existing.patternId) < 0) existing.patternId = pattern.id;
    } else {
      groupsByExplanation.set(explanation, {
        patternId: pattern.id,
        explanation,
        patternIds: new Set([pattern.id]),
        memberPatternKeys: new Set([pattern.patternKey]),
      });
    }
  }

  const acceptedForGroup = (group: RuleGroup, end: string, days: number): number => {
    const start = shiftDate(end, -(days - 1));
    return occurrences.filter((occurrence) =>
      occurrence.decision === "accepted"
      && group.patternIds.has(occurrence.patternId)
      && within(occurrence.localDate, start, end)).length;
  };

  const acceptedPromptHashesForGroup = (group: RuleGroup): Set<string> => new Set(
    occurrences
      .filter((occurrence) => occurrence.decision === "accepted" && group.patternIds.has(occurrence.patternId))
      .map((occurrence) => occurrence.promptHash),
  );
  const recurringGroups = [...groupsByExplanation.values()].filter((group) =>
    acceptedPromptHashesForGroup(group).size >= 2);
  const oneOffAccepted = [...groupsByExplanation.values()]
    .filter((group) => acceptedPromptHashesForGroup(group).size === 1)
    .reduce((sum, group) => sum + acceptedForGroup(group, today, TREND_DAYS), 0);

  const rules = recurringGroups.flatMap((group): RuleAnalytics[] => {
    const accepted = acceptedForGroup(group, today, TREND_DAYS);
    const previousAccepted = acceptedForGroup(group, previousEnd, TREND_DAYS);
    if (accepted === 0 && previousAccepted === 0) return [];
    const currentRate = ratePerThousand(accepted, currentThirty.words);
    const previousRate = ratePerThousand(previousAccepted, previousThirty.words);
    const trend = previousAccepted === 0 && accepted > 0
      ? "new"
      : classifyRuleTrend(currentRate, previousRate);
    const sparklineValues = Array.from({ length: 7 }, (_, index) => {
      const end = shiftDate(today, index - 6);
      const window = totals(end, 7);
      return ratePerThousand(acceptedForGroup(group, end, 7), window.words);
    });
    const changePercent = trend !== "new" && trend !== "stable"
      && previousRate !== undefined && previousRate > 0 && currentRate !== undefined
      ? (currentRate - previousRate) / previousRate * 100
      : undefined;
    return [{
      patternId: group.patternId,
      rowKey: practiceRuleRowKey(group.explanation),
      explanation: group.explanation,
      memberPatternKeys: [...group.memberPatternKeys].sort((left, right) => left.localeCompare(right)),
      accepted,
      ratePerThousand: currentRate,
      sparkline: renderSparkline(sparklineValues),
      trend,
      ...(changePercent === undefined ? {} : { changePercent }),
    }];
  }).sort((left, right) =>
    right.accepted - left.accepted
    || (right.ratePerThousand ?? -Infinity) - (left.ratePerThousand ?? -Infinity)
    || left.explanation.localeCompare(right.explanation));

  const trendCounts: Record<RuleTrend, number> = { improving: 0, worsening: 0, stable: 0, new: 0 };
  for (const rule of rules) trendCounts[rule.trend] += 1;

  const activeRules = recurringGroups.filter((group) =>
    acceptedForGroup(group, today, 7) > 0).length;

  const currentRatePerThousand = ratePerThousand(currentSeven.accepted, currentSeven.words);
  const periodRatePerThousand = ratePerThousand(currentThirty.accepted, currentThirty.words);
  const reviewCoverage = reviewable > 0 ? reviewed / reviewable : undefined;
  return {
    pendingOccurrences: visiblePending.length,
    periodPendingOccurrences: visiblePendingInPeriod,
    activeRules,
    ...(currentRatePerThousand === undefined ? {} : { currentRatePerThousand }),
    ...(periodRatePerThousand === undefined ? {} : { periodRatePerThousand }),
    toolbarSparkline: renderSparkline(trailingRates),
    englishWords: currentThirty.words,
    accepted: currentThirty.accepted,
    dismissed: currentThirty.dismissed,
    oneOffAccepted,
    ...(reviewCoverage === undefined ? {} : { reviewCoverage }),
    rules,
    trendCounts,
  };
}
