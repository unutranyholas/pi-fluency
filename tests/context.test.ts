import { describe, expect, it } from "vitest";
import { materializeMistake } from "../extensions/pi-fluency/context.js";
import type { RawAnalyzerMistake } from "../extensions/pi-fluency/types.js";

describe("materializeMistake", () => {
  const article: RawAnalyzerMistake = {
    original: "a modal",
    correction: "the modal",
    contextScope: "previous-and-current",
    explanation: "Previously introduced reference.",
    errorType: "R:DET",
    patternKey: "grammar.articles.definite-reference",
    confidence: 0.95,
  };

  it("derives previous and current sentences and changes only verified quote", () => {
    const result = materializeMistake("We discussed one modal earlier. I opened a modal with a hotkey.", article);
    expect(result.sourceExcerpt).toBe("We discussed one modal earlier. I opened a modal with a hotkey.");
    expect(result.correctedExcerpt).toBe("We discussed one modal earlier. I opened the modal with a hotkey.");
  });

  it("supports current and next sentence scope", () => {
    const result = materializeMistake("I opened a modal. Then I pressed enter.", {
      ...article,
      contextScope: "current-and-next",
    });
    expect(result.sourceExcerpt).toBe("I opened a modal. Then I pressed enter.");
  });

  it("rejects absent, empty, or ambiguous source quotes", () => {
    expect(() => materializeMistake("No matching text.", article)).toThrow("Source quote not found exactly once");
    expect(() => materializeMistake("a modal and a modal.", article)).toThrow("Source quote not found exactly once");
    expect(() => materializeMistake("Some text.", { ...article, original: "" })).toThrow("Source quote not found exactly once");
  });

  it("caps both excerpts while preserving one exact replacement", () => {
    const prose = `${"Earlier context. ".repeat(40)}I opened a modal with a hotkey.`;
    const result = materializeMistake(prose, { ...article, contextScope: "sentence" });
    expect(result.sourceExcerpt.length).toBeLessThanOrEqual(500);
    expect(result.correctedExcerpt.length).toBeLessThanOrEqual(500);
    expect(result.correctedExcerpt).toBe(result.sourceExcerpt.replace(article.original, article.correction));
  });

  it("leaves expansion room for a 500-character correction", () => {
    const correction = "z".repeat(500);
    const result = materializeMistake(`${"a".repeat(250)}x${"b".repeat(250)}.`, {
      ...article,
      original: "x",
      correction,
      contextScope: "sentence",
    });
    expect(result.sourceExcerpt).toBe("x");
    expect(result.correctedExcerpt).toBe(correction);
    expect(result.sourceExcerpt.length).toBeLessThanOrEqual(500);
    expect(result.correctedExcerpt.length).toBeLessThanOrEqual(500);
  });

  it.each([
    `[x]${"a".repeat(596)}.`,
    `${"a".repeat(596)}[x].`,
  ])("caps expanding replacements at sentence boundaries", (prose) => {
    const correction = "z".repeat(103);
    const result = materializeMistake(prose, {
      ...article,
      original: "[x]",
      correction,
      contextScope: "sentence",
    });
    expect(result.sourceExcerpt.length).toBe(400);
    expect(result.correctedExcerpt.length).toBe(500);
    expect(result.correctedExcerpt).toBe(result.sourceExcerpt.replace("[x]", correction));
    expect((result.sourceExcerpt.match(/\[x\]/g) ?? [])).toHaveLength(1);
  });

  it("rejects excerpt sizes that cannot satisfy both caps", () => {
    expect(() => materializeMistake("x.", {
      ...article,
      original: "x",
      correction: "z".repeat(501),
    })).toThrow(new Error("Invalid analysis result"));
  });
});
