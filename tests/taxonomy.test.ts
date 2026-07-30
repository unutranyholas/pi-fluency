import { describe, expect, it } from "vitest";
import {
  ERRANT_CATEGORIES,
  ERRANT_CATEGORY_LABELS,
  ERRANT_ERROR_TYPES,
  ERRANT_OPERATIONS,
  errantCategory,
  isErrantErrorType,
} from "../extensions/pi-fluency/taxonomy.js";

const EXPECTED_CATEGORIES = [
  "ADJ", "ADJ:FORM", "ADV", "CONJ", "CONTR", "DET", "MORPH", "NOUN",
  "NOUN:INFL", "NOUN:NUM", "NOUN:POSS", "ORTH", "OTHER", "PART", "PREP",
  "PRON", "PUNCT", "SPELL", "VERB", "VERB:FORM", "VERB:INFL", "VERB:SVA",
  "VERB:TENSE", "WO",
] as const;

const EXPECTED_LABELS = {
  ADJ: "Adjective",
  "ADJ:FORM": "Adjective form",
  ADV: "Adverb",
  CONJ: "Conjunction",
  CONTR: "Contraction",
  DET: "Determiner",
  MORPH: "Morphology",
  NOUN: "Noun",
  "NOUN:INFL": "Noun inflection",
  "NOUN:NUM": "Noun number",
  "NOUN:POSS": "Noun possessive",
  ORTH: "Capitalization / spacing",
  OTHER: "Other",
  PART: "Particle",
  PREP: "Preposition",
  PRON: "Pronoun",
  PUNCT: "Punctuation",
  SPELL: "Spelling",
  VERB: "Verb",
  "VERB:FORM": "Verb form",
  "VERB:INFL": "Verb inflection",
  "VERB:SVA": "Subject–verb agreement",
  "VERB:TENSE": "Verb tense",
  WO: "Word order",
} as const;

describe("ERRANT taxonomy", () => {
  it("exposes the exact 24 controlled categories", () => {
    expect(ERRANT_CATEGORIES).toEqual(EXPECTED_CATEGORIES);
    expect(new Set(ERRANT_CATEGORIES).size).toBe(24);
  });

  it("derives all 72 operation/category combinations in stable order", () => {
    const expected = ERRANT_OPERATIONS.flatMap((operation) =>
      EXPECTED_CATEGORIES.map((category) => `${operation}:${category}`),
    );
    expect(ERRANT_OPERATIONS).toEqual(["M", "U", "R"]);
    expect(ERRANT_ERROR_TYPES).toEqual(expected);
    expect(new Set(ERRANT_ERROR_TYPES).size).toBe(72);
    expect(ERRANT_ERROR_TYPES.every(isErrantErrorType)).toBe(true);
  });

  it("strictly rejects values outside the controlled types", () => {
    expect(isErrantErrorType("R:VERB:FORM")).toBe(true);
    for (const value of [
      null, undefined, 1, {}, [], "", "R", "R:", ":VERB", "X:VERB",
      "r:VERB", "R:verb", "R:VERB:UNKNOWN", "R:VERB:FORM:EXTRA",
      " R:VERB", "R:VERB ", "M:ARTICLE",
    ]) {
      expect(isErrantErrorType(value), String(value)).toBe(false);
    }
  });

  it("strips only the operation prefix", () => {
    expect(errantCategory("M:PUNCT")).toBe("PUNCT");
    expect(errantCategory("U:ADJ:FORM")).toBe("ADJ:FORM");
    expect(errantCategory("R:VERB:FORM")).toBe("VERB:FORM");
  });

  it("provides an exhaustive curated human label record", () => {
    expect(ERRANT_CATEGORY_LABELS).toEqual(EXPECTED_LABELS);
    expect(Object.keys(ERRANT_CATEGORY_LABELS)).toEqual(EXPECTED_CATEGORIES);
  });

});
