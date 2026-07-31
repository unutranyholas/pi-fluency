import { vi } from "vitest";
import {
  FluencyOverlay,
  type FluencyOverlayOptions,
  type IgnoreTarget,
  type PracticeOverlayState,
} from "../../extensions/pi-fluency/overlay.js";
import type { FluencyAnalytics } from "../../extensions/pi-fluency/analytics.js";
import { errantCategory, type ErrantCategory } from "../../extensions/pi-fluency/taxonomy.js";
import { DEFAULT_PRACTICE_SETTINGS, type ReviewPattern } from "../../extensions/pi-fluency/types.js";

const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export const framedPlain = (lines: string[]) => lines.map((line) => line.replace(ansi, ""));

export const plain = (lines: string[]) => {
  const stripped = framedPlain(lines);
  if (!stripped[0]?.startsWith("╭") || !stripped.at(-1)?.startsWith("╰")) return stripped;
  return stripped.slice(1, -1).map((line) => line.startsWith("│") ? line.slice(1, -1).trimEnd() : line);
};

export function pattern(id: string, overrides: Partial<ReviewPattern> = {}): ReviewPattern {
  return {
    id,
    patternKey: `grammar.articles.${id}`,
    original: "an",
    correction: "a",
    sourceExcerpt: `I want to have an ${id} agent with a deliberately long context.`,
    correctedExcerpt: `I want to have a ${id} agent with a deliberately long context.`,
    explanation: "Use “a” before a consonant sound. This explanation can wrap safely.",
    errorType: "R:DET",
    confidence: 0.99,
    firstSeenAt: 1,
    lastSeenAt: id === "second" ? 2 : 1,
    occurrenceCount: 3,
    demonstratedFixCount: 2,
    pendingCount: 3,
    acceptedCount: 0,
    dismissedCount: 0,
    ...overrides,
  };
}

export const emptyStats: FluencyAnalytics = {
  pendingOccurrences: 0,
  periodPendingOccurrences: 0,
  activeRules: 0,
  toolbarSparkline: "·······",
  dailyRateSparkline: "·".repeat(30),
  englishWords: 0,
  accepted: 0,
  dismissed: 0,
  oneOffAccepted: 0,
  rules: [],
  trendCounts: { improving: 0, worsening: 0, stable: 0, new: 0 },
};

export function makeOverlay(options: {
  patterns?: ReviewPattern[];
  stats?: FluencyAnalytics;
  initialView?: FluencyOverlayOptions["initialView"];
  fail?: boolean;
  rows?: number;
  ignoredPatternKeys?: string[];
  ignoredCategories?: ErrantCategory[];
  practice?: PracticeOverlayState;
  overrides?: Partial<FluencyOverlayOptions>;
} = {}) {
  const actions: string[] = [];
  const tui = { requestRender: vi.fn(), terminal: { rows: options.rows ?? 30 } };
  const patterns = options.patterns ?? [pattern("first"), pattern("second")];
  const ignoredPatternKeys = new Set(options.ignoredPatternKeys ?? []);
  const ignoredCategories = new Set(options.ignoredCategories ?? []);
  const practice = options.practice ?? {
    settings: { ...DEFAULT_PRACTICE_SETTINGS, targets: [] },
    targets: [],
    sessionSnoozed: false,
    now: 123,
  };
  const overlay = new FluencyOverlay({
    tui,
    theme: { fg: (_color, text) => `\u001b[31m${text}\u001b[39m` },
    keybindings: {
      matches: (data, binding) => ({
        "tui.select.up": "\u001b[A",
        "tui.select.down": "\u001b[B",
        "tui.select.confirm": "\r",
        "tui.select.cancel": "\u001b",
        "tui.select.pageUp": "\u001b[5~",
        "tui.select.pageDown": "\u001b[6~",
      }[binding] === data),
    },
    patterns: () => {
      if (options.fail) throw new Error("store unavailable");
      return patterns;
    },
    stats: () => options.stats ?? emptyStats,
    practice: () => practice,
    ...(options.initialView ? { initialView: options.initialView } : {}),
    selectIgnore: async (_title, choices) => choices[0],
    accept: (id) => {
      actions.push(`accept:${id}`);
      const item = patterns.find((candidate) => candidate.id === id);
      if (item) {
        item.acceptedCount += item.pendingCount;
        item.pendingCount = 0;
      }
    },
    dismiss: (id) => {
      actions.push(`dismiss:${id}`);
      const item = patterns.find((candidate) => candidate.id === id);
      if (item) {
        item.dismissedCount += item.pendingCount;
        item.pendingCount = 0;
      }
    },
    ignoredBy: (item) => {
      const targets: IgnoreTarget[] = [];
      if (ignoredPatternKeys.has(item.patternKey)) targets.push({ kind: "pattern", value: item.patternKey });
      const category = errantCategory(item.errorType);
      if (ignoredCategories.has(category)) targets.push({ kind: "category", value: category });
      return targets;
    },
    ignorePattern: (key, item) => {
      actions.push(`ignore-rule:${item.id}`);
      ignoredPatternKeys.add(key);
    },
    ignoreCategory: (category) => {
      actions.push(`ignore-category:${category}`);
      ignoredCategories.add(category);
    },
    restoreIgnored: (targets, item) => {
      actions.push(`restore:${item.id}:${targets.map((target) => `${target.kind}:${target.value}`).join(",")}`);
      for (const target of targets) {
        if (target.kind === "pattern") ignoredPatternKeys.delete(target.value);
        else ignoredCategories.delete(target.value);
      }
    },
    activatePractice: (target) => {
      actions.push(`practice-consent:${target?.explanation ?? "master"}`);
      practice.settings = {
        ...practice.settings,
        revision: practice.settings.revision + 1,
        consentedAt: practice.now,
        enabled: true,
        targets: target ? [target] : [],
      };
      practice.targets = target
        ? [{ ...target, rowKey: `selected:${target.explanation}`, currentPatternKeys: [...target.memberPatternKeys], coachingEnabled: true }]
        : [];
    },
    setPracticeTarget: (target, selected) => {
      actions.push(`practice-target:${selected ? "select" : "remove"}:${target.explanation}`);
      practice.settings = {
        ...practice.settings,
        revision: practice.settings.revision + 1,
        targets: selected
          ? [...practice.settings.targets.filter((item) => item.explanation !== target.explanation), target]
          : practice.settings.targets.filter((item) => item.explanation !== target.explanation),
      };
      practice.targets = practice.targets.filter((item) => item.explanation !== target.explanation);
      if (selected) practice.targets.push({ ...target, rowKey: `selected:${target.explanation}`, currentPatternKeys: [...target.memberPatternKeys], coachingEnabled: true });
    },
    viewChanged: (view) => { actions.push(`view:${view}`); },
    close: () => { actions.push("close"); },
    ...options.overrides,
  });
  return { actions, overlay, tui, ignoredPatternKeys, ignoredCategories };
}
