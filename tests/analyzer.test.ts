import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "@earendil-works/pi-ai/compat";
import { AnalyzerConfigurationError, buildAnalysisPrompt, ModelAnalyzer, validateAnalysisResult } from "../extensions/pi-fluency/analyzer.js";
import type { CollectedPrompt, MistakePattern } from "../extensions/pi-fluency/types.js";

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: vi.fn() }));

const prompt: CollectedPrompt = { prose: "I need an parallel agent.", promptHash: "h", observedAt: 1 };
const pattern: MistakePattern = {
  id: "p", patternKey: "grammar.articles.a-before-consonant", original: "an parallel",
  correction: "a parallel", sourceExcerpt: "I need an parallel agent.", correctedExcerpt: "I need a parallel agent.",
  explanation: "Use a before consonant sounds.", errorType: "R:DET",
  confidence: 0.9, firstSeenAt: 1, lastSeenAt: 1, occurrenceCount: 1,
  demonstratedFixCount: 0,
};

const rawResult = {
  schemaVersion: 3,
  language: "en",
  mistakes: [{
    original: "an parallel", correction: "a parallel", contextScope: "sentence",
    explanation: "Article agreement.", errorType: "R:DET",
    patternKey: "grammar.articles.a-before-consonant", confidence: 0.95,
  }],
  demonstratedFixes: [
    { patternKey: pattern.patternKey, evidence: "parallel agent", confidence: 0.9 },
    { patternKey: "unknown.pattern", evidence: "not comparable", confidence: 0.9 },
  ],
};

describe("analysis contract", () => {
  it("includes current prose, controlled values, and bounded known patterns", () => {
    const value = JSON.parse(buildAnalysisPrompt(prompt, Array.from({ length: 501 }, (_, index) => ({
      ...pattern,
      patternKey: `grammar.articles.article-a-before-consonant-${index}`,
    }))));
    expect(value.prose).toBe(prompt.prose);
    expect(value.knownPatterns).toHaveLength(500);
    expect(value.knownPatterns[0]).toEqual({
      patternKey: "grammar.articles.article-a-before-consonant-0",
      explanation: "Use a before consonant sounds.",
      errorType: "R:DET",
    });
    expect(value.allowedErrorTypes).toEqual(expect.arrayContaining(["M:DET", "R:VERB:FORM", "U:PUNCT"]));
    expect(value).not.toHaveProperty("allowedClassIds");
    expect(value.allowedContextScopes).toEqual(["sentence", "previous-and-current", "current-and-next"]);
  });

  it("accepts valid output, normalizes unknown error types, and filters low confidence", () => {
    const result = validateAnalysisResult({
      ...rawResult,
      mistakes: [{ ...rawResult.mistakes[0], errorType: "future.class" }],
      demonstratedFixes: [{ patternKey: "old-pattern", evidence: "correct evidence", confidence: 0.4 }],
    }, 0.8);
    expect(result.mistakes).toHaveLength(1);
    expect(result.mistakes[0]?.errorType).toBe("R:OTHER");
    expect(result.demonstratedFixes).toHaveLength(0);
  });

  it("accepts a non-English result only when both result arrays are empty", () => {
    expect(validateAnalysisResult({
      schemaVersion: 3,
      language: "other",
      mistakes: [],
      demonstratedFixes: [],
    }, 0.8)).toEqual({
      schemaVersion: 3,
      language: "other",
      mistakes: [],
      demonstratedFixes: [],
    });
  });

  it("caps result arrays", () => {
    const result = validateAnalysisResult({
      schemaVersion: 3,
      language: "en",
      mistakes: Array.from({ length: 30 }, (_, index) => ({
        ...rawResult.mistakes[0],
        patternKey: `grammar.articles.rule-${index}`,
      })),
      demonstratedFixes: Array.from({ length: 30 }, () => rawResult.demonstratedFixes[0]),
    }, 0.8);
    expect(result.mistakes).toHaveLength(20);
    expect(result.demonstratedFixes).toHaveLength(25);
    expect(result.mistakes[0]?.errorType).toBe("R:DET");
  });

  it("removes terminal controls from every accepted model string", () => {
    const result = validateAnalysisResult({
      schemaVersion: 3,
      language: "en",
      mistakes: [{
        ...rawResult.mistakes[0],
        original: "an\u001b[31m parallel",
        correction: "a\u0007 parallel",
        explanation: "safe\u001b[2J explanation",
        patternKey: "grammar.articles.a-before-consonant\u001b[0m",
        errorType: "R:DET\u001b[31m",
      }],
      demonstratedFixes: [{
        patternKey: `${pattern.patternKey}\u001b[0m`, evidence: "parallel\u0000 agent", confidence: 0.9,
      }],
    }, 0.8);
    expect(JSON.stringify(result)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(result.mistakes[0]).toMatchObject({ original: "an parallel", correction: "a parallel" });
    expect(result.mistakes[0]?.errorType).toBe("R:OTHER");
  });

  it.each([
    null,
    {},
    { schemaVersion: 2, language: "en", mistakes: [], demonstratedFixes: [] },
    { schemaVersion: 3, language: "en", mistakes: [{ ...rawResult.mistakes[0], contextScope: "paragraph" }], demonstratedFixes: [] },
    { schemaVersion: 3, language: "en", mistakes: [{ ...rawResult.mistakes[0], confidence: Number.NaN }], demonstratedFixes: [] },
    { schemaVersion: 3, language: "other", mistakes: [rawResult.mistakes[0]], demonstratedFixes: [] },
    { schemaVersion: 3, language: "other", mistakes: [{ ...rawResult.mistakes[0], confidence: 0.1 }], demonstratedFixes: [] },
    { schemaVersion: 3, language: "other", mistakes: [], demonstratedFixes: [rawResult.demonstratedFixes[0]] },
    { schemaVersion: 3, language: "other", mistakes: [], demonstratedFixes: [{ ...rawResult.demonstratedFixes[0], confidence: 0.1 }] },
    { schemaVersion: 3, language: "unknown", mistakes: [], demonstratedFixes: [] },
  ])("rejects malformed value %#", (value) => {
    expect(() => validateAnalysisResult(value, 0.8)).toThrow("Invalid analysis result");
  });
});

describe("ModelAnalyzer", () => {
  beforeEach(() => vi.mocked(complete).mockReset());

  it("forwards resolved auth and signal, materializes mistakes, and keeps only known fixes", async () => {
    vi.mocked(complete).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(rawResult) }],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1,
    });
    const model = { provider: "test-provider", api: "test-api" } as Model<string>;
    const registry = {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({
        ok: true, apiKey: "secret", headers: { "x-auth": "header" }, env: { REGION: "local" },
      }),
    } as unknown as ModelRegistry;
    const signal = new AbortController().signal;

    const result = await new ModelAnalyzer({ model, registry, minimumConfidence: 0.8 })
      .analyze(prompt, [pattern], signal);

    expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
    expect(complete).toHaveBeenCalledWith(
      model,
      expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
      { apiKey: "secret", headers: { "x-auth": "header" }, env: { REGION: "local" }, signal },
    );
    expect(result.language).toBe("en");
    expect(result.mistakes[0]?.sourceExcerpt).toBe(prompt.prose);
    expect(result.mistakes[0]?.correctedExcerpt).toBe("I need a parallel agent.");
    expect(result.demonstratedFixes).toEqual([rawResult.demonstratedFixes[0]]);
  });

  it("tells the model the exact analysis response schema", async () => {
    vi.mocked(complete).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify({ schemaVersion: 3, language: "en", mistakes: [], demonstratedFixes: [] }) }],
      api: "test-api", provider: "test-provider", model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 1,
    });
    const model = { provider: "test-provider", api: "test-api" } as Model<string>;
    const registry = { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "secret" }) } as unknown as ModelRegistry;

    await new ModelAnalyzer({ model, registry, minimumConfidence: 0.8 })
      .analyze(prompt, [], new AbortController().signal);

    const request = vi.mocked(complete).mock.calls[0]?.[1];
    expect(request?.systemPrompt).toContain(
      '{"schemaVersion":3,"language":"en","mistakes":[{"original":"exact erroneous quote","correction":"corrected quote","contextScope":"sentence","explanation":"brief rule","errorType":"R:DET","patternKey":"grammar.articles.example-rule","confidence":0.95}',
    );
    expect(request?.systemPrompt).toContain(
      '"demonstratedFixes":[{"patternKey":"grammar.articles.example-rule","evidence":"exact correct quote","confidence":0.95}]',
    );
  });

  it("drops hallucinated, empty-after-sanitization, and unknown demonstrated-fix evidence", async () => {
    vi.mocked(complete).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify({
        ...rawResult,
        demonstratedFixes: [
          rawResult.demonstratedFixes[0],
          { patternKey: pattern.patternKey, evidence: "hallucinated quote", confidence: 0.9 },
          { patternKey: "unknown.pattern", evidence: "parallel agent", confidence: 0.9 },
        ],
      }) }],
      api: "test-api", provider: "test-provider", model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 1,
    });
    const model = { provider: "test-provider", api: "test-api" } as Model<string>;
    const registry = { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "secret" }) } as unknown as ModelRegistry;
    const result = await new ModelAnalyzer({ model, registry, minimumConfidence: 0.8 })
      .analyze(prompt, [pattern], new AbortController().signal);
    expect(result.demonstratedFixes).toEqual([rawResult.demonstratedFixes[0]]);
  });

  it("sanitizes malformed model JSON errors", async () => {
    const secretFragment = "fake-secret-token";
    vi.mocked(complete).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: `{\"mistakes\": [${secretFragment}` }],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1,
    });
    const model = { provider: "test-provider", api: "test-api" } as Model<string>;
    const registry = {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "secret" }),
    } as unknown as ModelRegistry;

    let thrown: unknown;
    try {
      await new ModelAnalyzer({ model, registry, minimumConfidence: 0.8 })
        .analyze(prompt, [], new AbortController().signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Invalid analysis result");
    expect((thrown as Error).message).not.toContain(secretFragment);
  });

  it("converts rejected auth resolution to a sanitized configuration error", async () => {
    const secretFragment = "credential-secret-from-provider";
    const model = { provider: "test-provider", api: "test-api" } as Model<string>;
    const registry = {
      getApiKeyAndHeaders: vi.fn().mockRejectedValue(new Error(secretFragment)),
    } as unknown as ModelRegistry;

    let thrown: unknown;
    try {
      await new ModelAnalyzer({ model, registry, minimumConfidence: 0.8 })
        .analyze(prompt, [], new AbortController().signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AnalyzerConfigurationError);
    expect((thrown as Error).message).toBe("Unable to resolve model authentication");
    expect((thrown as Error).message).not.toContain(secretFragment);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    { auth: { ok: true }, secret: undefined },
    { auth: { ok: false, error: "provider leaked credential-secret" }, secret: "credential-secret" },
  ])("fails with bounded copy before model call when auth is unavailable %#", async ({ auth, secret }) => {
    const model = { provider: "test-provider\u001b[31m", api: "test-api" } as Model<string>;
    const registry = { getApiKeyAndHeaders: vi.fn().mockResolvedValue(auth) } as unknown as ModelRegistry;
    let thrown: unknown;
    try {
      await new ModelAnalyzer({ model, registry, minimumConfidence: 0.8 })
        .analyze(prompt, [], new AbortController().signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AnalyzerConfigurationError);
    expect((thrown as Error).message).toBe("Model authentication unavailable");
    if (secret) expect((thrown as Error).message).not.toContain(secret);
    expect(complete).not.toHaveBeenCalled();
  });
});
