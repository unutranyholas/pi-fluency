import { visibleWidth } from "@earendil-works/pi-tui";

export interface CompactDiffInput {
  sourceExcerpt: string;
  correctedExcerpt: string;
  original: string;
  correction: string;
}

export interface CompactDiffStyles {
  deletion(text: string): string;
  insertion(text: string): string;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

const TOKEN = /\s+|[\p{L}\p{N}'’-]+|[^\s]/gu;
export interface CompactDiffFallback {
  source: string;
  correction: string;
}

const fallbackOutputs = new WeakMap<string[], CompactDiffFallback>();

function tokenize(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function verifiedOffset(input: CompactDiffInput): number | undefined {
  if (input.original.length === 0) return undefined;
  let offset = input.sourceExcerpt.indexOf(input.original);
  while (offset >= 0) {
    const candidate = input.sourceExcerpt.slice(0, offset)
      + input.correction
      + input.sourceExcerpt.slice(offset + input.original.length);
    if (candidate === input.correctedExcerpt) return offset;
    offset = input.sourceExcerpt.indexOf(input.original, offset + 1);
  }
  return undefined;
}

function visibleWhitespace(text: string): string {
  return [...text].map((character) => {
    if (character === "\t") return "⇥";
    if (character === "\n" || character === "\r") return "↵";
    return "␠";
  }).join("");
}

function differingTokenSpan(source: string, corrected: string): CompactDiffFallback {
  const sourceTokens = tokenize(source);
  const correctedTokens = tokenize(corrected);
  let prefix = 0;
  while (
    prefix < sourceTokens.length
    && prefix < correctedTokens.length
    && sourceTokens[prefix]!.text === correctedTokens[prefix]!.text
  ) prefix += 1;

  let suffix = 0;
  while (
    suffix < sourceTokens.length - prefix
    && suffix < correctedTokens.length - prefix
    && sourceTokens[sourceTokens.length - 1 - suffix]!.text === correctedTokens[correctedTokens.length - 1 - suffix]!.text
  ) suffix += 1;

  const span = (text: string, tokens: Token[]): string => {
    const first = tokens[prefix];
    const last = tokens[tokens.length - suffix - 1];
    if (!first || !last || last.end < first.start) return "∅";
    const raw = text.slice(first.start, last.end);
    if (raw.length === 0) return "∅";
    if (/^\s+$/u.test(raw)) return visibleWhitespace(raw);
    return raw.trim();
  };
  return { source: span(source, sourceTokens), correction: span(corrected, correctedTokens) };
}

function fallback(input: CompactDiffInput): string[] {
  const fallback = differingTokenSpan(input.sourceExcerpt, input.correctedExcerpt);
  const lines = [fallback.source, `└─ ${fallback.correction}`];
  fallbackOutputs.set(lines, fallback);
  return lines;
}

/** Return layout metadata only for the unverifiable/legacy token-diff fallback. */
export function compactDiffFallback(lines: string[]): CompactDiffFallback | undefined {
  return fallbackOutputs.get(lines);
}

/** Render one deterministic, compact edit without mutating either excerpt. */
export function renderCompactDiff(input: CompactDiffInput, styles: CompactDiffStyles): string[] {
  const excerptOffset = verifiedOffset(input);
  if (excerptOffset === undefined) return fallback(input);

  const removed = tokenize(input.original);
  const added = tokenize(input.correction);
  let prefix = 0;
  while (prefix < removed.length && prefix < added.length && removed[prefix]!.text === added[prefix]!.text) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < removed.length - prefix
    && suffix < added.length - prefix
    && removed[removed.length - 1 - suffix]!.text === added[added.length - 1 - suffix]!.text
  ) suffix += 1;

  const removedStart = prefix < removed.length ? removed[prefix]!.start : input.original.length;
  const removedEndIndex = removed.length - suffix - 1;
  const removedEnd = removedEndIndex >= prefix ? removed[removedEndIndex]!.end : removedStart;
  const addedStart = prefix < added.length ? added[prefix]!.start : input.correction.length;
  const addedEndIndex = added.length - suffix - 1;
  const addedEnd = addedEndIndex >= prefix ? added[addedEndIndex]!.end : addedStart;
  const removedText = input.original.slice(removedStart, removedEnd);
  const addedText = input.correction.slice(addedStart, addedEnd);

  if (removedText && addedText) {
    const annotationOffset = excerptOffset + removedStart;
    return [
      input.sourceExcerpt,
      `${" ".repeat(visibleWidth(input.sourceExcerpt.slice(0, annotationOffset)))}└─ ${addedText}`,
    ];
  }

  if (removedText) {
    const start = excerptOffset + removedStart;
    const end = excerptOffset + removedEnd;
    return [input.sourceExcerpt.slice(0, start) + styles.deletion(removedText) + input.sourceExcerpt.slice(end)];
  }

  if (addedText) {
    const start = excerptOffset + addedStart;
    const end = excerptOffset + addedEnd;
    return [input.correctedExcerpt.slice(0, start) + styles.insertion(addedText) + input.correctedExcerpt.slice(end)];
  }

  return input.sourceExcerpt === input.correctedExcerpt ? [input.sourceExcerpt] : fallback(input);
}
