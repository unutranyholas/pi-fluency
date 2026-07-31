import { describe, expect, it } from "vitest";
import {
  classifyRuleTrend,
  computeFluencyAnalytics,
  countEnglishWords,
  ratePerThousand,
  renderSparkline,
} from "../extensions/pi-fluency/analytics.js";
import type {
  EnglishObservation,
  MistakeOccurrence,
  MistakePattern,
  OccurrenceDecision,
} from "../extensions/pi-fluency/types.js";

const NOW = new Date(2026, 6, 20, 12).getTime();

function day(offset: number): string {
  const date = new Date(Date.UTC(2026, 6, 20 + offset));
  return date.toISOString().slice(0, 10);
}

function observation(offset: number, wordCount: number, occurrenceIds: string[] = []): EnglishObservation {
  return {
    promptHash: `prompt-${offset}`,
    observedAt: NOW + offset * 86_400_000,
    localDate: day(offset),
    wordCount,
    occurrenceIds,
  };
}

function pattern(id: string, explanation = `Rule ${id}`, errorType: MistakePattern["errorType"] = "R:DET"): MistakePattern {
  return {
    id,
    patternKey: `rule.${id}`,
    original: "wrong",
    correction: "right",
    sourceExcerpt: "wrong example",
    correctedExcerpt: "right example",
    explanation,
    errorType,
    confidence: 0.9,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    occurrenceCount: 1,
    demonstratedFixCount: 0,
  };
}

function occurrence(
  id: string,
  patternId: string,
  offset: number,
  decision: OccurrenceDecision,
): MistakeOccurrence {
  return {
    id,
    promptHash: `prompt-${offset}`,
    patternId,
    patternKey: `rule.${patternId}`,
    observedAt: NOW + offset * 86_400_000,
    localDate: day(offset),
    decision,
  };
}

function repeated(
  prefix: string,
  count: number,
  patternId: string,
  offset: number,
  decision: OccurrenceDecision,
): MistakeOccurrence[] {
  return Array.from({ length: count }, (_, index) => ({
    ...occurrence(`${prefix}-${index}`, patternId, offset, decision),
    promptHash: `${prefix}-prompt-${index}`,
  }));
}

describe("countEnglishWords", () => {
  it.each([
    ["I write clear prompts.", 4],
    ["I don't repeat users’ mistakes.", 5],
    ["version 3 has 1 contract", 5],
    ["  multiple\nspaces\tstay harmless ", 4],
    ["", 0],
  ])("counts %j", (prose, expected) => {
    expect(countEnglishWords(prose)).toBe(expected);
  });
});

describe("analytics primitives", () => {
  it("normalizes accepted mistakes without inventing a missing denominator", () => {
    expect(ratePerThousand(8, 1_000)).toBe(8);
    expect(ratePerThousand(8, 0)).toBeUndefined();
  });

  it("renders missing, ranged, zero, and flat nonzero series deterministically", () => {
    expect(renderSparkline(Array(7).fill(undefined))).toBe("·······");
    expect(renderSparkline([0, 1, 2, 3, 4, 5, 6])).toBe("▁▂▃▅▆▇█");
    expect(renderSparkline(Array(7).fill(0))).toBe("▁▁▁▁▁▁▁");
    expect(renderSparkline(Array(7).fill(2))).toBe("▄▄▄▄▄▄▄");
  });

  it("requires both relative and absolute materiality for trends", () => {
    expect(classifyRuleTrend(2, undefined)).toBe("new");
    expect(classifyRuleTrend(2, 0)).toBe("new");
    expect(classifyRuleTrend(4, 5)).toBe("improving");
    expect(classifyRuleTrend(6, 5)).toBe("worsening");
    expect(classifyRuleTrend(5.4, 5)).toBe("stable");
    expect(classifyRuleTrend(1.5, 1.1)).toBe("stable");
  });
});

describe("computeFluencyAnalytics", () => {
  it("calculates English-only rates, visible review coverage, active rules, and ignored history", () => {
    const patterns = [
      pattern("a", "Use a before consonant sounds."),
      pattern("b", "Use in for months."),
      pattern("ignored", "Ignored determiner rule."),
      pattern("ignored-category", "Ignored preposition rule.", "R:PREP"),
    ];
    const occurrences = [
      ...repeated("accepted-a", 5, "a", 0, "accepted"),
      ...repeated("accepted-b", 2, "b", -6, "accepted"),
      occurrence("accepted-ignored", "ignored", 0, "accepted"),
      ...repeated("dismissed", 4, "a", 0, "dismissed"),
      ...repeated("pending", 12, "a", 0, "pending"),
      ...repeated("hidden-pending", 2, "ignored", 0, "pending"),
      occurrence("hidden-category-pending", "ignored-category", 0, "pending"),
    ];
    const result = computeFluencyAnalytics({
      observations: [observation(0, 500), observation(-6, 500), observation(-40, 9_000)],
      occurrences,
      patterns,
      ignoredPatternKeys: new Set(["rule.ignored"]),
      ignoredCategories: new Set(["PREP"]),
      now: NOW,
    });

    expect(result).toMatchObject({
      pendingOccurrences: 12,
      activeRules: 2,
      currentRatePerThousand: 8,
      englishWords: 1_000,
      accepted: 8,
      dismissed: 4,
      reviewCoverage: 0.5,
      oneOffAccepted: 1,
    });
    expect(result.rules.map((rule) => rule.explanation)).toEqual([
      "Use a before consonant sounds.",
      "Use in for months.",
    ]);
    expect(result.rules.some((rule) => rule.patternId.includes("rule."))).toBe(false);
  });

  it("separates 30-day Stats totals from seven-day toolbar metrics", () => {
    const result = computeFluencyAnalytics({
      observations: [observation(0, 100), observation(-10, 900)],
      occurrences: [
        ...repeated("older-accepted", 9, "a", -10, "accepted"),
        ...repeated("current-pending", 2, "a", 0, "pending"),
        occurrence("old-pending", "a", -40, "pending"),
      ],
      patterns: [pattern("a")],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(result.currentRatePerThousand).toBe(0);
    expect(result.periodRatePerThousand).toBe(9);
    expect(result.pendingOccurrences).toBe(3);
    expect(result.periodPendingOccurrences).toBe(2);
    expect(result).toMatchObject({ englishWords: 1_000, accepted: 9 });
  });

  it("uses seven local-date trailing windows and renders no denominator as dots", () => {
    const observations = Array.from({ length: 13 }, (_, index) => observation(index - 12, 100));
    const result = computeFluencyAnalytics({
      observations,
      occurrences: [occurrence("today", "a", 0, "accepted")],
      patterns: [pattern("a")],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });
    expect(result.toolbarSparkline).toBe("▁▁▁▁▁▁█");
    expect(result.currentRatePerThousand).toBeCloseTo(10 / 7);

    const boundary = computeFluencyAnalytics({
      observations: [observation(-7, 100), observation(-6, 100)],
      occurrences: [
        occurrence("outside-current-seven", "a", -7, "accepted"),
        occurrence("inside-current-seven", "a", -6, "accepted"),
      ],
      patterns: [pattern("a")],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });
    expect(boundary.currentRatePerThousand).toBe(10);

    const empty = computeFluencyAnalytics({
      observations: [],
      occurrences: [],
      patterns: [],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });
    expect(empty.toolbarSparkline).toBe("·······");
    expect(empty.currentRatePerThousand).toBeUndefined();
    expect(empty.reviewCoverage).toBeUndefined();
  });

  it("groups identical concrete explanations and classifies adjacent 30-day rule trends", () => {
    const patterns = [
      pattern("improve-a", "Shared improving rule."),
      pattern("improve-b", "Shared improving rule."),
      pattern("worse", "Worsening rule."),
      pattern("stable", "Stable rule."),
      pattern("new", "New rule."),
    ];
    const occurrences = [
      ...repeated("improve-previous", 10, "improve-a", -30, "accepted"),
      ...repeated("improve-current-a", 3, "improve-a", 0, "accepted"),
      ...repeated("improve-current-b", 2, "improve-b", 0, "accepted"),
      ...repeated("worse-previous", 5, "worse", -30, "accepted"),
      ...repeated("worse-current", 7, "worse", 0, "accepted"),
      ...repeated("stable-previous", 5, "stable", -30, "accepted"),
      ...repeated("stable-current", 5, "stable", 0, "accepted"),
      occurrence("new-current", "new", 0, "accepted"),
    ];
    const result = computeFluencyAnalytics({
      observations: [observation(-30, 1_000), observation(0, 1_000)],
      occurrences,
      patterns,
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(result.rules).toHaveLength(3);
    expect(result.rules.map((rule) => [rule.explanation, rule.accepted, rule.trend])).toEqual([
      ["Worsening rule.", 7, "worsening"],
      ["Shared improving rule.", 5, "improving"],
      ["Stable rule.", 5, "stable"],
    ]);
    expect(result.oneOffAccepted).toBe(1);
    expect(result.trendCounts).toEqual({ improving: 1, worsening: 1, stable: 1, new: 0 });
    expect(result.rules[1]).toMatchObject({ ratePerThousand: 5, changePercent: -50 });
  });

  it("keeps a retained recurring rule active with one recent acceptance and ages it out after seven days", () => {
    const recurring = computeFluencyAnalytics({
      observations: [observation(0, 100), observation(-40, 100)],
      occurrences: [
        occurrence("recent", "a", 0, "accepted"),
        occurrence("retained-old", "a", -40, "accepted"),
      ],
      patterns: [pattern("a")],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(recurring.activeRules).toBe(1);
    expect(recurring.rules.map((rule) => rule.explanation)).toEqual(["Rule a"]);
    expect(recurring.oneOffAccepted).toBe(0);

    const inactive = computeFluencyAnalytics({
      observations: [observation(-7, 100), observation(-40, 100)],
      occurrences: [
        occurrence("recent-but-inactive", "a", -7, "accepted"),
        occurrence("retained-old", "a", -40, "accepted"),
      ],
      patterns: [pattern("a")],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(inactive.activeRules).toBe(0);
    expect(inactive.rules.map((rule) => rule.explanation)).toEqual(["Rule a"]);
  });

  it("promotes singleton pattern IDs that share one explanation across distinct prompts", () => {
    const result = computeFluencyAnalytics({
      observations: [observation(0, 100), observation(-1, 100)],
      occurrences: [
        occurrence("first-shape", "a", 0, "accepted"),
        occurrence("second-shape", "b", -1, "accepted"),
      ],
      patterns: [pattern("a", "Shared article rule."), pattern("b", "Shared article rule.")],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(result.activeRules).toBe(1);
    expect(result.oneOffAccepted).toBe(0);
    expect(result.rules.map((rule) => [rule.explanation, rule.accepted])).toEqual([
      ["Shared article rule.", 2],
    ]);
  });

  it("keeps repeated accepted findings from one prompt in the one-off aggregate", () => {
    const result = computeFluencyAnalytics({
      observations: [observation(0, 200)],
      occurrences: [
        occurrence("first-shape", "a", 0, "accepted"),
        occurrence("second-shape", "b", 0, "accepted"),
      ],
      patterns: [pattern("a", "Shared article rule."), pattern("b", "Shared article rule.")],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(result.activeRules).toBe(0);
    expect(result.oneOffAccepted).toBe(2);
    expect(result.rules).toEqual([]);
  });

  it("does not mutate input collections", () => {
    const observations = [observation(0, 100)];
    const occurrences = [occurrence("pending", "a", 0, "pending")];
    const patterns = [pattern("a")];
    const before = JSON.stringify({ observations, occurrences, patterns });
    computeFluencyAnalytics({
      observations,
      occurrences,
      patterns,
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });
    expect(JSON.stringify({ observations, occurrences, patterns })).toBe(before);
  });
});
