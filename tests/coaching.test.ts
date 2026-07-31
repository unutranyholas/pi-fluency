import { describe, expect, it } from "vitest";
import {
  analysisReuseAction,
  analyzerResultFingerprint,
  boundedCoachingMistakes,
  gatePolicyFingerprint,
  isCoachingEligible,
  revalidateCoachingPolicy,
  selectedCoachingMistakes,
} from "../extensions/pi-fluency/coaching.js";
import type {
  AnalysisResult,
  FluencySettings,
  PracticePolicySnapshot,
  PracticeSettings,
} from "../extensions/pi-fluency/types.js";

const settings: FluencySettings = {
  schemaVersion: 3,
  enabled: true,
  consentedAt: 1,
  provider: "provider",
  modelId: "model",
  minimumConfidence: 0.8,
  retentionLimit: 500,
  ignoredPatternKeys: [],
  ignoredCategories: [],
};
const practice: PracticeSettings = {
  schemaVersion: 1,
  revision: 1,
  epoch: 0,
  enabled: true,
  consentedAt: 2,
  targets: [{ explanation: "Use articles", memberPatternKeys: ["grammar.article.rule"] }],
};
const policy: PracticePolicySnapshot = { settings, practice };
const mistake = (patternKey: string, explanation: string): AnalysisResult["mistakes"][number] => ({
  original: "an agent",
  correction: "a agent",
  sourceExcerpt: "I use an agent.",
  correctedExcerpt: "I use a agent.",
  contextScope: "sentence",
  explanation,
  errorType: "R:DET",
  patternKey,
  confidence: 0.95,
});
const result: AnalysisResult = {
  schemaVersion: 3,
  language: "en",
  mistakes: [
    mistake("grammar.article.rule", "Changed analyzer wording"),
    mistake("grammar.other.rule", "Unrelated rule"),
  ],
  demonstratedFixes: [{ patternKey: "grammar.other.rule", evidence: "other", confidence: 0.9 }],
};

describe("coaching policy", () => {
  it("requires interactive eligible text, both consents, active targets, and no snooze", () => {
    const eligible = {
      source: "interactive",
      idle: true,
      textOnly: true,
      collectionEligible: true,
      sessionSnoozed: false,
      now: 100,
      policy,
    };
    expect(isCoachingEligible(eligible)).toBe(true);
    expect(isCoachingEligible({ ...eligible, source: "rpc" })).toBe(false);
    expect(isCoachingEligible({ ...eligible, textOnly: false })).toBe(false);
    expect(isCoachingEligible({ ...eligible, sessionSnoozed: true })).toBe(false);
    expect(isCoachingEligible({ ...eligible, policy: { settings, practice: { ...practice, snoozedUntil: 101 } } })).toBe(false);
    const { consentedAt: _consent, ...practiceWithoutConsent } = practice;
    expect(isCoachingEligible({ ...eligible, policy: { settings, practice: practiceWithoutConsent } })).toBe(false);
  });

  it("gates selected non-ignored mistakes while preserving complete result for reuse", () => {
    const matches = selectedCoachingMistakes(result, settings, practice);
    expect(matches.map((item) => item.patternKey)).toEqual(["grammar.article.rule"]);
    expect(result.mistakes).toHaveLength(2);
    expect(result.demonstratedFixes).toHaveLength(1);

    expect(selectedCoachingMistakes(result, {
      ...settings,
      ignoredPatternKeys: ["grammar.article.rule"],
    }, practice)).toEqual([]);
  });

  it("bounds presentation without truncating reusable analysis", () => {
    const many: AnalysisResult = {
      ...result,
      mistakes: Array.from({ length: 5 }, (_, index) => mistake(`grammar.article.rule-${index}`, "Use articles")),
    };
    expect(boundedCoachingMistakes(many, settings, practice)).toHaveLength(3);
    expect(many.mistakes).toHaveLength(5);
  });

  it("uses separate analyzer and gate fingerprints with change-specific revalidation", () => {
    const gateChanged = { settings, practice: { ...practice, enabled: false } };
    const analyzerChanged = { settings: { ...settings, minimumConfidence: 0.9 }, practice };
    const disabled = { settings: { ...settings, enabled: false }, practice };

    expect(analyzerResultFingerprint(settings)).toBe(analyzerResultFingerprint({
      ...settings,
      ignoredPatternKeys: ["ignored"],
    }));
    expect(gatePolicyFingerprint(policy)).not.toBe(gatePolicyFingerprint(gateChanged));
    expect(revalidateCoachingPolicy(policy, policy)).toBe("unchanged");
    expect(revalidateCoachingPolicy(policy, gateChanged)).toBe("gate-changed");
    expect(revalidateCoachingPolicy(policy, analyzerChanged)).toBe("analyzer-changed");
    expect(revalidateCoachingPolicy(policy, disabled)).toBe("analytics-disabled");
    expect(revalidateCoachingPolicy(policy, {
      settings: { ...settings, ignoredPatternKeys: ["grammar.article.rule"] },
      practice,
    })).toBe("gate-changed");
    expect(revalidateCoachingPolicy(policy, {
      settings,
      practice: { ...practice, snoozedUntil: 500 },
    })).toBe("gate-changed");
  });

  it("maps terminal outcomes and fresh policy to one result-reuse handoff", () => {
    expect(analysisReuseAction("continue", "unchanged")).toBe("commit-foreground");
    expect(analysisReuseAction("continue", "gate-changed")).toBe("commit-foreground");
    expect(analysisReuseAction("continue", "analyzer-changed")).toBe("queue-background");
    expect(analysisReuseAction("continue", "analytics-disabled")).toBe("discard");
    expect(analysisReuseAction("edit", "unchanged")).toBe("discard");
  });
});
