import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderCompactDiff } from "../extensions/pi-fluency/diff.js";
import { wrapCompactDiff } from "../extensions/pi-fluency/overlay.js";
import type { FluencyAnalytics } from "../extensions/pi-fluency/analytics.js";
import {
  emptyStats,
  framedPlain,
  makeOverlay,
  pattern,
  plain,
} from "./helpers/overlay-fixtures.js";

describe("FluencyOverlay rendering", () => {
  it("renders privacy-safe review analytics directly in Stats", () => {
    const stats: FluencyAnalytics = {
      pendingOccurrences: 99,
      periodPendingOccurrences: 12,
      activeRules: 6,
      currentRatePerThousand: 1.2,
      periodRatePerThousand: 8.4,
      toolbarSparkline: "▆▄▃▂▁▂▂",
      englishWords: 5_014,
      accepted: 42,
      dismissed: 9,
      oneOffAccepted: 7,
      reviewCoverage: 0.81,
      trendCounts: { improving: 8, worsening: 3, stable: 5, new: 2 },
      rules: [{
        patternId: "hidden-id",
        rowKey: "hidden-row-key",
        explanation: "Use a before consonant sounds.",
        memberPatternKeys: ["hidden.member.key"],
        accepted: 8,
        ratePerThousand: 2.4,
        sparkline: "▇▆▅▄▃▂▁",
        trend: "improving",
        changePercent: -40,
      }],
    };
    const fixture = makeOverlay({
      stats,
      initialView: "stats",
      patterns: [pattern("private", { patternKey: "hidden.pattern.key", errorType: "R:DET" })],
    });
    const text = plain(fixture.overlay.render(80)).join("\n");

    expect(text).toContain("Pi Fluency · Stats");
    expect(text).toContain("Fluency trend · 30 days");
    expect(text).toContain("Accepted rate");
    expect(text).toContain("8.4 / 1000 English words");
    expect(text).toContain("English words");
    expect(text).toContain("5,014");
    expect(text).toContain("Pending             12");
    expect(text).toContain("One-off accepted mistakes");
    expect(text).toMatch(/One-off accepted mistakes\s+7/);
    expect(text).toContain("Review coverage");
    expect(text).toContain("81%");
    expect(text).toContain("↓ 8 improving");
    expect(text).toContain("↑ 3 worsening");
    expect(text).toContain("Use a before consonant sounds.");
    expect(text).toContain("2.4/k");
    expect(text).toContain("▇▆▅▄▃▂▁");
    expect(text).toContain("▆▄▃▂▁▂▂  1.2/k");
    expect(text).not.toContain("hidden-id");
    expect(text).not.toContain("hidden-row-key");
    expect(text).not.toContain("hidden.member.key");
    expect(text).not.toContain("hidden.pattern.key");
    expect(text).not.toContain("R:DET");
    expect(text).not.toContain("a accept");
  });

  it("renders empty Stats and wraps safely at narrow width", () => {
    const fixture = makeOverlay({ stats: emptyStats, initialView: "stats", rows: 60 });
    const rendered = fixture.overlay.render(40);
    const text = plain(rendered).join("\n");
    expect(text).toContain("Accepted rate");
    expect(text.replace(/\s+/g, " ")).toContain("— / 1000 English words");
    expect(text).toContain("Review coverage");
    expect(text).toContain("—");
    expect(text.replace(/\s+/g, " ")).toContain("No recurring concrete rules in this period.");
    expect(rendered.every((line) => visibleWidth(line) === 40)).toBe(true);
  });

  it("scrolls long Stats vertically without horizontal card navigation resetting it", async () => {
    const rules = Array.from({ length: 20 }, (_, index) => ({
      patternId: `hidden-${index}`,
      rowKey: `row-${index}`,
      explanation: `Concrete coaching rule ${index} with enough detail to wrap.`,
      memberPatternKeys: [`rule.member-${index}`],
      accepted: 20 - index,
      ratePerThousand: 2,
      sparkline: "▁▂▃▄▅▆▇",
      trend: "stable" as const,
    }));
    const fixture = makeOverlay({
      rows: 15,
      initialView: "stats",
      stats: { ...emptyStats, rules, trendCounts: { improving: 0, worsening: 0, stable: 20, new: 0 } },
    });
    const initial = plain(fixture.overlay.render(56));
    await fixture.overlay.handleInput("j");
    const scrolled = plain(fixture.overlay.render(56));
    expect(scrolled).not.toEqual(initial);
    await fixture.overlay.handleInput("\u001b[C");
    expect(plain(fixture.overlay.render(56))).toEqual(scrolled);
  });

  it("renders a complete aligned themed border at supported widths", () => {
    const { overlay } = makeOverlay();
    for (const width of [30, 56, 80]) {
      const rendered = overlay.render(width);
      const visible = framedPlain(rendered);
      expect(visible[0]).toBe(`╭${"─".repeat(width - 2)}╮`);
      expect(visible.at(-1)).toBe(`╰${"─".repeat(width - 2)}╯`);
      expect(visible.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
      expect(rendered.every((line) => visibleWidth(line) === width)).toBe(true);
      expect(rendered[0]).toContain("\u001b[31m");
    }
  });

  it("never renders beyond supplied width using actual ANSI visible widths", () => {
    const { overlay } = makeOverlay();
    for (const width of [1, 30, 56, 80]) {
      expect(overlay.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("renders only the selected mistake in a paged carousel", async () => {
    const fixture = makeOverlay({ patterns: [pattern("first"), pattern("second")] });
    const first = plain(fixture.overlay.render(80)).join("\n");
    expect(first).toContain("Pending 3 · accepted 0 · ← 1 / 2 →");
    expect(first).toContain("first");
    expect(first).not.toContain("second");

    await fixture.overlay.handleInput("\u001b[C");
    const second = plain(fixture.overlay.render(80)).join("\n");
    expect(second).toContain("← 2 / 2 →");
    expect(second).toContain("second");
    expect(second).not.toContain("first");
    expect(second).not.toContain("Rule:");
    expect(second).not.toContain("Classes:");
  });

  it("wraps large progress and paging values into pinned header lines at minimum width", async () => {
    const patterns = Array.from({ length: 123 }, (_, index) => pattern(`large-${index}`, {
      pendingCount: 9_876_543_210,
      acceptedCount: 1_234_567_890,
    }));
    const fixture = makeOverlay({ patterns, rows: 30 });
    for (let index = 1; index < patterns.length; index += 1) await fixture.overlay.handleInput("\u001b[C");

    const rendered = fixture.overlay.render(56);
    const text = plain(rendered).join("\n");
    expect(text).toContain("Pending 9876543210");
    expect(text).toContain("accepted 1234567890");
    expect(text.replace(/\s+/g, " ")).toContain("← 123 / 123 →");
    expect(text).toContain("large-122");
    expect(plain(rendered).at(-1)).toBe(" i ignore  tab view  esc close");
    expect(rendered.every((line) => visibleWidth(line) === 56)).toBe(true);
  });

  it.each([["j", "k"], ["\u001b[B", "\u001b[A"]])(
    "%s and %s scroll only the current card vertically",
    async (down, up) => {
      const fixture = makeOverlay({
        rows: 20,
        patterns: [pattern("first", { explanation: "scrolling explanation ".repeat(100) }), pattern("second")],
      });
      const initial = plain(fixture.overlay.render(48));
      await fixture.overlay.handleInput(down);
      const scrolled = plain(fixture.overlay.render(48));
      expect(scrolled).not.toEqual(initial);
      expect(scrolled.slice(0, 3).join(" ")).toContain("Pending 3 · accepted 0 · ← 1 / 2");
      expect(scrolled.join("\n")).not.toContain("second");
      await fixture.overlay.handleInput(up);
      expect(plain(fixture.overlay.render(48))).toEqual(initial);
    },
  );

  it("renders one card at the end of a long carousel within terminal height", async () => {
    const patterns = Array.from({ length: 24 }, (_, index) => pattern(`item-${index}`));
    const fixture = makeOverlay({ patterns, rows: 30 });
    for (let index = 1; index < patterns.length; index += 1) await fixture.overlay.handleInput("\u001b[C");

    const lines = plain(fixture.overlay.render(80));
    expect(lines.length + 2).toBeLessThanOrEqual(24);
    expect(lines.some((line) => line.includes("› I want to have an item-23"))).toBe(true);
    expect(lines.join("\n")).not.toContain("item-22");
    expect(lines.at(-1)).toBe(" i ignore  tab view  esc close");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it.each([
    { name: "late in the excerpt", original: "but", correction: "But", affectedText: "make, but then" },
    { name: "on the first token", original: "well", correction: "Well", affectedText: "well, now I will" },
  ])("wraps compact diffs without detaching an error $name", ({ original, correction, affectedText }) => {
    const sourceExcerpt = "well, now I will write a long message to you, doing my best and trying to avoid mistakes I usually make, but then I will add a typo.";
    const correctedExcerpt = sourceExcerpt.replace(original, correction);
    const fixture = makeOverlay({
      rows: 100,
      patterns: [pattern("long-diff", {
        original,
        correction,
        sourceExcerpt,
        correctedExcerpt,
        explanation: "Capitalize this word.",
      })],
    });

    const lines = plain(fixture.overlay.render(40));
    const sourceStart = lines.findIndex((line) => line.startsWith(" › "));
    const blockEnd = lines.indexOf("", sourceStart);
    const diffLines = lines.slice(sourceStart, blockEnd);
    const correctionIndex = diffLines.findIndex((line) => line.includes(`└─ ${correction}`));
    const affectedIndex = diffLines.findIndex((line) => line.includes(affectedText));
    const recoveredSource = diffLines
      .filter((line) => !line.includes("└─"))
      .map((line) => line.slice(3).trim())
      .join(" ");

    expect(recoveredSource).toBe(sourceExcerpt);
    expect(correctionIndex).toBe(affectedIndex + 1);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("reflows source text to align a right-edge arrow with the exact error column", () => {
    const wrapped = wrapCompactDiff([
      "abcdefghijklX trailing text",
      `${" ".repeat(12)}└─ x`,
    ], "›", 18);
    const sourceIndex = wrapped.findIndex((line) => line.includes("X"));
    const correctionIndex = wrapped.findIndex((line) => line.includes("└─"));

    expect(correctionIndex).toBe(sourceIndex + 1);
    expect(wrapped[correctionIndex]!.indexOf("└─")).toBe(wrapped[sourceIndex]!.indexOf("X"));
    expect(wrapped[correctionIndex]).toBe("   └─ x");
    expect(wrapped.every((line) => visibleWidth(line) <= 18)).toBe(true);
  });

  it("wraps long corrections under their arrow and renders aligned recoverable fallback spans", () => {
    const correction = "make effective use of the available option";
    const wrapped = wrapCompactDiff([
      "Please utilise this option.",
      `${" ".repeat(7)}└─ ${correction}`,
    ], "›", 24);
    const correctionIndex = wrapped.findIndex((line) => line.includes("└─"));
    const correctionPrefixWidth = wrapped[correctionIndex]!.indexOf("└─") + "└─ ".length;
    const recoveredCorrection = wrapped
      .slice(correctionIndex, wrapped.findIndex((line, index) => index > correctionIndex && line.trimStart().startsWith("option.")))
      .map((line, index) => index === 0 ? line.slice(correctionPrefixWidth) : line.slice(correctionPrefixWidth).trimEnd())
      .join(" ");

    expect(recoveredCorrection).toBe(correction);
    expect(wrapped.every((line) => visibleWidth(line) <= 24)).toBe(true);

    const fallbackDiff = renderCompactDiff({
      sourceExcerpt: "A shared opening has an outdated and needlessly verbose phrase before a shared ending.",
      correctedExcerpt: "A shared opening has a concise and substantially clearer phrase before a shared ending.",
      original: "legacy claim",
      correction: "new claim",
    }, { deletion: (text) => text, insertion: (text) => text });
    const fallback = wrapCompactDiff(fallbackDiff, "›", 24);
    const fallbackCorrectionIndex = fallback.findIndex((line) => line.includes("└─"));
    const sourceLines = fallback.slice(0, fallbackCorrectionIndex);
    const correctionLines = fallback.slice(fallbackCorrectionIndex);
    const recoveredSource = sourceLines.map((line) => line.slice(3).trim()).join(" ");
    const recoveredFallbackCorrection = correctionLines.map((line) => line.slice(6).trim()).join(" ");
    expect(recoveredSource).toBe("an outdated and needlessly verbose");
    expect(recoveredFallbackCorrection).toBe("a concise and substantially clearer");
    expect(correctionLines[0]!.indexOf("└─")).toBe(sourceLines[0]!.indexOf("an"));
    expect(fallback.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("wraps and recovers visible whitespace-only fallback spans within the width", () => {
    const visibleWhitespace = "␠⇥↵".repeat(7);
    const fallbackDiff = renderCompactDiff({
      sourceExcerpt: `left,${" \t\n".repeat(7)}right`,
      correctedExcerpt: "left,right",
      original: "unverifiable",
      correction: "",
    }, { deletion: (text) => text, insertion: (text) => text });
    const wrapped = wrapCompactDiff(fallbackDiff, "›", 14);
    const correctionIndex = wrapped.findIndex((line) => line.includes("└─"));
    const recoveredSource = wrapped
      .slice(0, correctionIndex)
      .map((line) => line.slice(3))
      .join("");

    expect(recoveredSource).toBe(visibleWhitespace);
    expect(wrapped.slice(correctionIndex).map((line) => line.slice(6)).join("")).toBe("∅");
    expect(wrapped.every((line) => visibleWidth(line) <= 14)).toBe(true);
  });

  it("wraps the compact diff and explanation without rendering expanded labels", async () => {
    const explanation = "Use the corrected article before the consonant sound while preserving this complete deliberately verbose coaching explanation for later study.";
    const patternKey = "grammar.articles.extremely-long-deterministic-pattern-key-without-breaks-and-with-a-readable-tail";
    const fixture = makeOverlay({
      rows: 500,
      patterns: [pattern("long", { explanation, patternKey })],
    });

    const lines = plain(fixture.overlay.render(40));
    expect(lines.join(" ").replace(/\s+/g, " ")).toContain(explanation);
    expect(lines.join("\n")).not.toContain("Source:");
    expect(lines.join("\n")).not.toContain("Corrected:");
    expect(lines.join("\n")).not.toContain("Rule:");
    expect(lines.join("\n")).not.toContain("Classes:");
    expect(lines.join("\n")).not.toContain(patternKey);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(lines.at(-1)).toBe(" i ignore  tab view  esc close");

    const longExplanation = `${explanation} ${Array.from({ length: 80 }, (_, index) => `detail-${index}`).join(" ")} final-coaching-line`;
    const constrainedPattern = pattern("long", { explanation: longExplanation, patternKey });
    const constrained = makeOverlay({ rows: 20, patterns: [constrainedPattern] });
    const expectedBody = [
      ...wrapCompactDiff(renderCompactDiff(constrainedPattern, { deletion: (text) => text, insertion: (text) => text }), "›", 38),
      "",
      ...wrapTextWithAnsi(longExplanation, 36).map((line) => ` ${line}`),
    ];
    const reached = new Set<string>();
    let page = plain(constrained.overlay.render(40));
    const firstPage = page;
    for (let pageCount = 0; pageCount < 100; pageCount += 1) {
      page.slice(2, -3).forEach((line) => reached.add(line));
      const previous = page;
      await constrained.overlay.handleInput("\u001b[6~");
      page = plain(constrained.overlay.render(40));
      if (page.join("\n") === previous.join("\n")) break;
    }
    expect(page).not.toEqual(firstPage);
    expect(page.join("\n")).toContain("final-coaching-line");
    expect(expectedBody.every((line) => reached.has(line.trimEnd()))).toBe(true);
    const finalPage = page;
    await constrained.overlay.handleInput("\u001b[6~");
    expect(plain(constrained.overlay.render(40))).toEqual(finalPage);
    expect(page.slice(0, 2)).toEqual(firstPage.slice(0, 2));
    expect(page.at(-1)).toBe(" i ignore  tab view  esc close");
  });

  it("clamps detail paging at end and after terminal resize", async () => {
    const explanation = "complete scrolling detail ".repeat(120);
    const fixture = makeOverlay({
      rows: 20,
      patterns: [pattern("scroll", { explanation, patternKey: `grammar.${"long-key-".repeat(40)}` })],
    });
    await fixture.overlay.handleInput("\r");
    fixture.overlay.render(48);
    for (let index = 0; index < 100; index += 1) await fixture.overlay.handleInput("\u001b[6~");
    const saturated = plain(fixture.overlay.render(48));
    await fixture.overlay.handleInput("\u001b[6~");
    expect(plain(fixture.overlay.render(48))).toEqual(saturated);
    await fixture.overlay.handleInput("\u001b[5~");
    expect(plain(fixture.overlay.render(48))).not.toEqual(saturated);

    for (let index = 0; index < 100; index += 1) await fixture.overlay.handleInput("\u001b[6~");
    fixture.tui.terminal.rows = 40;
    const resized = plain(fixture.overlay.render(48));
    await fixture.overlay.handleInput("\u001b[5~");
    expect(plain(fixture.overlay.render(48))).not.toEqual(resized);
  });

  it("renders stable empty and error states", () => {
    const empty = makeOverlay({ patterns: [] }).overlay;
    expect(plain(empty.render(48))).toEqual([
      " Pi Fluency · Inbox                  0 pending",
      " ────────────────────────────────────────────",
      " No pending patterns.",
      " ────────────────────────────────────────────",
      " ←→ card  ↑↓/jk scroll  a accept  d dismiss",
      " i ignore  tab view  esc close",
    ]);

    const failed = makeOverlay({ fail: true }).overlay;
    expect(plain(failed.render(48))).toEqual([
      " Pi Fluency · Inbox                  0 pending",
      " ────────────────────────────────────────────",
      " Could not load patterns: store unavailable",
      " ────────────────────────────────────────────",
      " ←→ card  ↑↓/jk scroll  a accept  d dismiss",
      " i ignore  tab view  esc close",
    ]);
  });
});
