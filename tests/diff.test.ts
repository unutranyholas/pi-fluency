import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderCompactDiff } from "../extensions/pi-fluency/diff.js";

const styles = {
  deletion: (text: string) => `\u001b[9m${text}\u001b[29m`,
  insertion: (text: string) => `\u001b[4m${text}\u001b[24m`,
};

describe("renderCompactDiff", () => {
  it("places replacement beneath original span", () => {
    expect(renderCompactDiff({
      sourceExcerpt: "I want to have an parallel agent…",
      original: "an",
      correction: "a",
      correctedExcerpt: "I want to have a parallel agent…",
    }, styles)).toEqual([
      "I want to have an parallel agent…",
      `${" ".repeat(15)}└─ a`,
    ]);
  });

  it("renders deletion inline with ANSI strikethrough", () => {
    const lines = renderCompactDiff({
      sourceExcerpt: "It is a very unique case.",
      original: "very ",
      correction: "",
      correctedExcerpt: "It is a unique case.",
    }, styles);
    expect(lines).toEqual(["It is a \u001b[9mvery \u001b[29munique case."]);
    expect(visibleWidth(lines[0]!)).toBe(25);
  });

  it("renders insertion inline with ANSI underline", () => {
    const lines = renderCompactDiff({
      sourceExcerpt: "It runs background.",
      original: "runs ",
      correction: "runs in the ",
      correctedExcerpt: "It runs in the background.",
    }, styles);
    expect(lines).toEqual(["It runs \u001b[4min the \u001b[24mbackground."]);
    expect(visibleWidth(lines[0]!)).toBe(26);
  });

  it("uses phrase-level replacement without changing compact grammar", () => {
    expect(renderCompactDiff({
      sourceExcerpt: "We want to have options.",
      original: "want to have",
      correction: "would like to have",
      correctedExcerpt: "We would like to have options.",
    }, styles)).toEqual(["We want to have options.", "   └─ would like"]);
  });

  it("uses concise token spans for unverifiable fallback edits", () => {
    expect(renderCompactDiff({
      sourceExcerpt: "Shared opening before the old phrase and shared ending.",
      original: "missing claim",
      correction: "fixed claim",
      correctedExcerpt: "Shared opening before a better phrase and shared ending.",
    }, styles)).toEqual([
      "the old",
      "└─ a better",
    ]);
  });

  it("renders whitespace-only fallback deletion visibly and preserves multiplicity", () => {
    expect(renderCompactDiff({
      sourceExcerpt: "Hello,  \t\nworld",
      original: "unverifiable",
      correction: "",
      correctedExcerpt: "Hello,world",
    }, styles)).toEqual([
      "␠␠⇥↵",
      "└─ ∅",
    ]);
  });

  it("renders whitespace-only fallback insertion visibly and preserves multiplicity", () => {
    expect(renderCompactDiff({
      sourceExcerpt: "Hello,world",
      original: "unverifiable",
      correction: "",
      correctedExcerpt: "Hello, \t\n world",
    }, styles)).toEqual([
      "∅",
      "└─ ␠⇥↵␠",
    ]);
  });
});
