import type { Api, Model, UserMessage } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type CollectedPrompt,
  type MistakePattern,
  type RawAnalysisResult,
} from "./types.js";
import {
  ERRANT_ERROR_TYPES,
  isErrantErrorType,
} from "./taxonomy.js";
import { materializeMistake } from "./context.js";
import { sanitizeAnalyzerField } from "./sanitize.js";

const CONTEXT_SCOPES = ["sentence", "previous-and-current", "current-and-next"] as const;
const MAX_KNOWN_PATTERNS = 500;
const MAX_MISTAKES = 20;
const MAX_DEMONSTRATED_FIXES = 25;

export class AnalyzerConfigurationError extends Error {
  override readonly name = "AnalyzerConfigurationError";
}

export interface Analyzer {
  analyze(
    prompt: CollectedPrompt,
    activePatterns: MistakePattern[],
    signal: AbortSignal,
  ): Promise<AnalysisResult>;
}

export function buildAnalysisPrompt(prompt: CollectedPrompt, activePatterns: MistakePattern[]): string {
  const knownPatterns = activePatterns
    .slice(0, MAX_KNOWN_PATTERNS)
    .map(({ patternKey, explanation, errorType }) => ({ patternKey, explanation, errorType }));
  return JSON.stringify({
    prose: prompt.prose,
    knownPatterns,
    allowedErrorTypes: ERRANT_ERROR_TYPES,
    allowedContextScopes: CONTEXT_SCOPES,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateAnalysisResult(value: unknown, minimumConfidence: number): RawAnalysisResult {
  if (
    !isRecord(value)
    || value.schemaVersion !== ANALYSIS_SCHEMA_VERSION
    || (value.language !== "en" && value.language !== "other")
    || !Array.isArray(value.mistakes)
    || !Array.isArray(value.demonstratedFixes)
  ) throw new Error("Invalid analysis result");

  if (value.language === "other" && (value.mistakes.length > 0 || value.demonstratedFixes.length > 0)) {
    throw new Error("Invalid analysis result");
  }

  const scopes = new Set<string>(CONTEXT_SCOPES);
  const validConfidence = (confidence: unknown): confidence is number =>
    typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;

  const mistakes: RawAnalysisResult["mistakes"] = [];
  for (const candidate of value.mistakes.slice(0, MAX_MISTAKES)) {
    if (!isRecord(candidate)) throw new Error("Invalid analysis result");
    const original = sanitizeAnalyzerField(candidate.original);
    const correction = sanitizeAnalyzerField(candidate.correction, true);
    const explanation = sanitizeAnalyzerField(candidate.explanation);
    const patternKey = sanitizeAnalyzerField(candidate.patternKey);
    const contextScope = candidate.contextScope;
    if (
      original === undefined || correction === undefined || explanation === undefined || patternKey === undefined
      || !/^[a-z]+(?:[.-][a-z0-9]+)+$/.test(patternKey)
      || typeof contextScope !== "string" || !scopes.has(contextScope)
      || !validConfidence(candidate.confidence)
    ) throw new Error("Invalid analysis result");
    if (candidate.confidence < minimumConfidence) continue;
    const errorType = isErrantErrorType(candidate.errorType) ? candidate.errorType : "R:OTHER";
    mistakes.push({ original, correction, explanation, patternKey, contextScope: contextScope as RawAnalysisResult["mistakes"][number]["contextScope"], errorType, confidence: candidate.confidence });
  }

  const demonstratedFixes: RawAnalysisResult["demonstratedFixes"] = [];
  for (const candidate of value.demonstratedFixes.slice(0, MAX_DEMONSTRATED_FIXES)) {
    if (!isRecord(candidate)) throw new Error("Invalid analysis result");
    const patternKey = sanitizeAnalyzerField(candidate.patternKey);
    const evidence = sanitizeAnalyzerField(candidate.evidence);
    if (patternKey === undefined || evidence === undefined || !validConfidence(candidate.confidence)) {
      throw new Error("Invalid analysis result");
    }
    if (candidate.confidence >= minimumConfidence) demonstratedFixes.push({ patternKey, evidence, confidence: candidate.confidence });
  }
  return { schemaVersion: ANALYSIS_SCHEMA_VERSION, language: value.language, mistakes, demonstratedFixes };
}

const SYSTEM_PROMPT = `You are Pi Fluency's English learning analyzer.
Return only one JSON object with exactly this shape:
{"schemaVersion":3,"language":"en","mistakes":[{"original":"exact erroneous quote","correction":"corrected quote","contextScope":"sentence","explanation":"brief rule","errorType":"R:DET","patternKey":"grammar.articles.example-rule","confidence":0.95}],"demonstratedFixes":[{"patternKey":"grammar.articles.example-rule","evidence":"exact correct quote","confidence":0.95}]}
Classify the supplied prose as English or other. For language "other", return empty mistakes and demonstratedFixes. Do not correct or translate non-English prose.
Use empty arrays when no mistakes or fixes exist. Do not rename fields or add fields.
For each mistake, original must be the shortest unique exact quote containing the error; choose contextScope and errorType only from supplied controlled values.
Report genuine grammar, spelling, word-choice, or idiomatic-usage errors only.
Do not report style preferences, capitalization of product names, or informal-but-valid wording.
A demonstrated fix must match one supplied knownPatterns pattern and quote comparable correct evidence.
Never infer a demonstrated fix merely because an earlier mistake is absent.
Reuse an existing knownPatterns patternKey for the same rule; mint a new namespaced lowercase key only when no known rule matches.
Keep every explanation under 240 characters. Return JSON only.`;

export class ModelAnalyzer implements Analyzer {
  constructor(private readonly options: {
    model: Model<Api>;
    registry: ModelRegistry;
    minimumConfidence: number;
  }) {}

  async analyze(
    prompt: CollectedPrompt,
    activePatterns: MistakePattern[],
    signal: AbortSignal,
  ): Promise<AnalysisResult> {
    let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
    try {
      auth = await this.options.registry.getApiKeyAndHeaders(this.options.model);
    } catch {
      throw new AnalyzerConfigurationError("Unable to resolve model authentication");
    }
    if (!auth.ok || !auth.apiKey) {
      throw new AnalyzerConfigurationError("Model authentication unavailable");
    }

    const message: UserMessage = {
      role: "user",
      content: buildAnalysisPrompt(prompt, activePatterns),
      timestamp: Date.now(),
    };
    const response = await complete(
      this.options.model,
      { systemPrompt: SYSTEM_PROMPT, messages: [message] },
      {
        apiKey: auth.apiKey,
        ...(auth.headers === undefined ? {} : { headers: auth.headers }),
        ...(auth.env === undefined ? {} : { env: auth.env }),
        signal,
      },
    );
    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error("Invalid analysis result");
    }
    const validated = validateAnalysisResult(parsed, this.options.minimumConfidence);
    const knownPatternKeys = new Set(activePatterns.map((pattern) => pattern.patternKey));
    return {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      language: validated.language,
      mistakes: validated.mistakes.map((mistake) => materializeMistake(prompt.prose, mistake)),
      demonstratedFixes: validated.demonstratedFixes.filter((fix) =>
        knownPatternKeys.has(fix.patternKey) && prompt.prose.includes(fix.evidence)),
    };
  }
}
