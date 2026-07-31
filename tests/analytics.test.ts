import { describe, expect, it } from "vitest";
import {
  classifyRuleTrend,
  computeFluencyAnalytics,
  countEnglishWords,
  practiceRuleRowKey,
  ratePerThousand,
  renderSparkline,
  resolvePracticeTargets,
  selectPracticeAnalysisContext,
  selectedTargetForMistake,
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

  it("renders a thirty-position daily rate chart without changing seven-position toolbar history", () => {
    const result = computeFluencyAnalytics({
      observations: [observation(0, 100)],
      occurrences: [occurrence("today", "a", 0, "accepted")],
      patterns: [pattern("a")],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(result.dailyRateSparkline).toHaveLength(30);
    expect(result.dailyRateSparkline[0]).toBe("·");
    expect(result.dailyRateSparkline.at(-1)).not.toBe("·");
    expect(result.toolbarSparkline).toHaveLength(7);
  });

  it("includes oldest and current daily boundaries while excluding 31 days ago", () => {
    const result = computeFluencyAnalytics({
      observations: [observation(-31, 100), observation(-29, 100), observation(0, 100)],
      occurrences: [
        ...repeated("outside", 100, "a", -31, "accepted"),
        occurrence("oldest", "a", -29, "accepted"),
        occurrence("current", "a", 0, "accepted"),
      ],
      patterns: [pattern("a")],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(result.dailyRateSparkline).toBe(`█${"·".repeat(28)}█`);
  });

  it("scales finite daily rates from zero while preserving dots and word-bearing zero days", () => {
    const result = computeFluencyAnalytics({
      observations: [
        observation(-2, 100),
        observation(-1, 100),
        observation(0, 100),
      ],
      occurrences: [
        occurrence("half-rate", "a", -2, "accepted"),
        ...repeated("maximum-rate", 2, "a", -1, "accepted"),
      ],
      patterns: [pattern("a")],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(result.dailyRateSparkline).toBe(`${"·".repeat(27)}▅█▁`);
  });

  it("renders word-bearing zero-accepted days as bars and no-word gaps as dots", () => {
    const result = computeFluencyAnalytics({
      observations: [observation(-10, 100)],
      occurrences: [],
      patterns: [],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(result.dailyRateSparkline).toBe(`${"·".repeat(19)}▁${"·".repeat(10)}`);
  });

  it("renders an empty thirty-day daily rate period as dots", () => {
    const result = computeFluencyAnalytics({
      observations: [],
      occurrences: [],
      patterns: [],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(result.dailyRateSparkline).toBe("·".repeat(30));
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

  it("preserves recurring ordering and numeric projections when selection metadata is added", () => {
    const result = computeFluencyAnalytics({
      observations: [observation(0, 1_000), observation(-30, 2_000)],
      occurrences: [
        ...repeated("alpha-now", 4, "alpha-b", 0, "accepted"),
        ...repeated("alpha-before", 2, "alpha-a", -30, "accepted"),
        ...repeated("beta-now", 3, "beta", 0, "accepted"),
        ...repeated("beta-before", 6, "beta", -30, "accepted"),
      ],
      patterns: [
        pattern("alpha-b", "Alpha rule."),
        pattern("alpha-a", "Alpha rule."),
        pattern("beta", "Beta rule."),
      ],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(result.rules.map(({ memberPatternKeys: _members, rowKey: _row, ...rule }) => rule)).toEqual([
      {
        patternId: "alpha-a",
        explanation: "Alpha rule.",
        accepted: 4,
        ratePerThousand: 4,
        sparkline: "······▄",
        trend: "worsening",
        changePercent: 300,
      },
      {
        patternId: "beta",
        explanation: "Beta rule.",
        accepted: 3,
        ratePerThousand: 3,
        sparkline: "······▄",
        trend: "stable",
      },
    ]);
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

  it("projects all group member keys and stable transient row identity", () => {
    const first = computeFluencyAnalytics({
      observations: [observation(0, 100), observation(-1, 100)],
      occurrences: [
        occurrence("one", "z-representative", 0, "accepted"),
        occurrence("two", "member", -1, "accepted"),
      ],
      patterns: [
        pattern("z-representative", "Shared rule."),
        pattern("member", "Shared rule."),
      ],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });
    const second = computeFluencyAnalytics({
      observations: [observation(0, 100), observation(-1, 100)],
      occurrences: [
        occurrence("one", "a-representative", 0, "accepted"),
        occurrence("two", "member", -1, "accepted"),
      ],
      patterns: [
        { ...pattern("a-representative", "Shared rule."), patternKey: "rule.z-representative" },
        pattern("member", "Shared rule."),
      ],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
      now: NOW,
    });

    expect(first.rules[0]).toMatchObject({
      memberPatternKeys: ["rule.member", "rule.z-representative"],
      rowKey: practiceRuleRowKey("Shared rule."),
    });
    expect(second.rules[0]!.patternId).toBe("a-representative");
    expect(second.rules[0]!.rowKey).toBe(first.rules[0]!.rowKey);
  });

  it("resolves retained targets and applies Ignore only to matching coaching candidates", () => {
    const targets = [{ explanation: "Retained rule.", memberPatternKeys: ["rule.old"] }];
    const current = [
      { ...pattern("new", "Retained rule.", "R:PREP"), patternKey: "rule.new" },
      pattern("other", "Other rule."),
    ];
    const resolved = resolvePracticeTargets({
      targets,
      patterns: current,
      ignoredPatternKeys: new Set(["rule.old"]),
      ignoredCategories: new Set(["PREP"]),
    });

    expect(resolved).toEqual([{
      rowKey: practiceRuleRowKey("Retained rule."),
      explanation: "Retained rule.",
      memberPatternKeys: ["rule.new", "rule.old"],
      currentPatternKeys: ["rule.new"],
      coachingEnabled: false,
    }]);
    expect(selectedTargetForMistake({
      patternKey: "rule.new",
      explanation: "Retained rule.",
      errorType: "R:PREP",
    }, targets, new Set(), new Set(["PREP"]))).toBeUndefined();
    expect(selectedTargetForMistake({
      patternKey: "rule.brand-new",
      explanation: "Retained rule.",
      errorType: "R:DET",
    }, targets, new Set(), new Set())).toEqual(targets[0]);
    expect(selectedTargetForMistake({
      patternKey: "rule.other",
      explanation: "Other rule.",
      errorType: "R:DET",
    }, targets, new Set(), new Set())).toBeUndefined();
  });

  it("keeps stale non-recurring targets coaching-enabled from durable metadata", () => {
    expect(resolvePracticeTargets({
      targets: [{ explanation: "Aged-out rule.", memberPatternKeys: ["rule.aged"] }],
      patterns: [],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
    })[0]).toMatchObject({
      explanation: "Aged-out rule.",
      memberPatternKeys: ["rule.aged"],
      currentPatternKeys: [],
      coachingEnabled: true,
    });
  });

  it("reserves complete target descriptors and deterministically bounds current pattern context", () => {
    const targets = [
      { explanation: "First target.", memberPatternKeys: ["rule.first-old", "rule.first-new"] },
      { explanation: "Second target.", memberPatternKeys: ["rule.second"] },
    ];
    const patterns = [
      { ...pattern("ordinary"), lastSeenAt: NOW + 100 },
      { ...pattern("first-old", "First target."), lastSeenAt: NOW - 10 },
      { ...pattern("second", "Second target."), lastSeenAt: NOW + 20 },
      { ...pattern("first-new", "First target."), lastSeenAt: NOW + 10 },
    ];

    const context = selectPracticeAnalysisContext(targets, patterns, 2);
    expect(context.targetDescriptors).toEqual(targets);
    expect(context.patterns.map((item) => item.patternKey)).toEqual([
      "rule.first-new",
      "rule.first-old",
    ]);
    expect(selectPracticeAnalysisContext(targets, [...patterns].reverse(), 2)).toEqual(context);
  });

  it("does not alias caller-owned patterns in practice analysis context", () => {
    const targets = [{ explanation: "Selected target.", memberPatternKeys: ["rule.selected"] }];
    const patterns = [pattern("selected", "Selected target."), pattern("ordinary")];
    const before = structuredClone(patterns);

    const context = selectPracticeAnalysisContext(targets, patterns, 2);
    context.patterns[0]!.explanation = "Mutated output.";
    context.patterns[1]!.occurrenceCount = 999;

    expect(patterns).toEqual(before);
  });

  it("rejects terminal and control payloads at target resolution seams", () => {
    const unsafe = [{ explanation: "Rule.\u001b[31m", memberPatternKeys: ["rule.safe"] }];
    expect(() => resolvePracticeTargets({
      targets: unsafe,
      patterns: [],
      ignoredPatternKeys: new Set(),
      ignoredCategories: new Set(),
    })).toThrow("Invalid practice target");
    expect(() => selectedTargetForMistake({
      patternKey: "rule.safe",
      explanation: "Rule.\u0007",
      errorType: "R:DET",
    }, [{ explanation: "Rule.", memberPatternKeys: ["rule.safe"] }], new Set(), new Set()))
      .toThrow("Invalid practice candidate");
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
