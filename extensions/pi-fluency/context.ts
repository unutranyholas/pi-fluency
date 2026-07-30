import type { AnalyzerMistake, RawAnalyzerMistake } from "./types.js";

const MAX_EXCERPT_LENGTH = 500;

export function materializeMistake(prose: string, raw: RawAnalyzerMistake): AnalyzerMistake {
  if (raw.original.length === 0) throw new Error("Source quote not found exactly once");

  const expansion = raw.correction.length - raw.original.length;
  const sourceLimit = Math.min(MAX_EXCERPT_LENGTH, MAX_EXCERPT_LENGTH - expansion);
  if (
    raw.original.length > MAX_EXCERPT_LENGTH
    || raw.correction.length > MAX_EXCERPT_LENGTH
    || sourceLimit < raw.original.length
  ) {
    throw new Error("Invalid analysis result");
  }

  const first = prose.indexOf(raw.original);
  const second = first < 0 ? -1 : prose.indexOf(raw.original, first + 1);
  if (first < 0 || second >= 0) throw new Error("Source quote not found exactly once");

  const segments = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(prose)];
  const sentenceIndex = segments.findIndex(
    (segment) => first >= segment.index && first < segment.index + segment.segment.length,
  );
  if (sentenceIndex < 0) throw new Error("Could not derive sentence context");

  const startIndex = raw.contextScope === "previous-and-current"
    ? Math.max(0, sentenceIndex - 1)
    : sentenceIndex;
  const endIndex = raw.contextScope === "current-and-next"
    ? Math.min(segments.length - 1, sentenceIndex + 1)
    : sentenceIndex;
  const excerptStart = segments[startIndex]!.index;
  const endSegment = segments[endIndex]!;
  const excerptEnd = endSegment.index + endSegment.segment.length;
  let sourceExcerpt = prose.slice(excerptStart, excerptEnd).trim();

  if (sourceExcerpt.length > sourceLimit) {
    const localIndex = sourceExcerpt.indexOf(raw.original);
    if (localIndex < 0) throw new Error("Invalid analysis result");

    const earliestWindowStart = Math.max(0, localIndex + raw.original.length - sourceLimit);
    const latestWindowStart = Math.min(localIndex, sourceExcerpt.length - sourceLimit);
    const preferredWindowStart = localIndex - 200;
    const windowStart = Math.min(
      latestWindowStart,
      Math.max(earliestWindowStart, preferredWindowStart),
    );
    sourceExcerpt = sourceExcerpt.slice(windowStart, windowStart + sourceLimit);
  }

  const localIndex = sourceExcerpt.indexOf(raw.original);
  if (localIndex < 0) throw new Error("Invalid analysis result");
  const correctedExcerpt = sourceExcerpt.slice(0, localIndex)
    + raw.correction
    + sourceExcerpt.slice(localIndex + raw.original.length);
  if (
    sourceExcerpt.length > MAX_EXCERPT_LENGTH
    || correctedExcerpt.length > MAX_EXCERPT_LENGTH
  ) {
    throw new Error("Invalid analysis result");
  }
  return { ...raw, sourceExcerpt, correctedExcerpt };
}
