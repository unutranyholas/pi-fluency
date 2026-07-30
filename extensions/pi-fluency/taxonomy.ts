export const ERRANT_OPERATIONS = ["M", "U", "R"] as const;
export type ErrantOperation = (typeof ERRANT_OPERATIONS)[number];

export const ERRANT_CATEGORIES = [
  "ADJ",
  "ADJ:FORM",
  "ADV",
  "CONJ",
  "CONTR",
  "DET",
  "MORPH",
  "NOUN",
  "NOUN:INFL",
  "NOUN:NUM",
  "NOUN:POSS",
  "ORTH",
  "OTHER",
  "PART",
  "PREP",
  "PRON",
  "PUNCT",
  "SPELL",
  "VERB",
  "VERB:FORM",
  "VERB:INFL",
  "VERB:SVA",
  "VERB:TENSE",
  "WO",
] as const;

export type ErrantCategory = (typeof ERRANT_CATEGORIES)[number];
export type ErrantErrorType = `${ErrantOperation}:${ErrantCategory}`;

export const ERRANT_ERROR_TYPES: ErrantErrorType[] = ERRANT_OPERATIONS.flatMap((operation) =>
  ERRANT_CATEGORIES.map((category) => `${operation}:${category}` as ErrantErrorType),
);

const ERRANT_ERROR_TYPE_SET = new Set<string>(ERRANT_ERROR_TYPES);

export function isErrantErrorType(value: unknown): value is ErrantErrorType {
  return typeof value === "string" && ERRANT_ERROR_TYPE_SET.has(value);
}

export function errantCategory(type: ErrantErrorType): ErrantCategory {
  return type.slice(2) as ErrantCategory;
}

export const ERRANT_CATEGORY_LABELS = {
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
} as const satisfies Record<ErrantCategory, string>;
