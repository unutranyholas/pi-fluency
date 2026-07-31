import { describe, expect, it, vi } from "vitest";
import { AnalyzerConfigurationError, type Analyzer } from "../extensions/pi-fluency/analyzer.js";
import { AnalyzerCoordinator, FluencyWorker, type WorkerOptions } from "../extensions/pi-fluency/worker.js";
import type { AnalysisResult, CollectedPrompt } from "../extensions/pi-fluency/types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function prompt(prose: string): CollectedPrompt {
  return { promptHash: `hash-${prose}`, prose, observedAt: 1 };
}

const emptyResult: AnalysisResult = { schemaVersion: 3, language: "en", mistakes: [], demonstratedFixes: [] };

function makeWorker(overrides: Partial<WorkerOptions> = {}): FluencyWorker {
  return new FluencyWorker({
    analyzer: { analyze: vi.fn().mockResolvedValue(emptyResult) },
    isIdle: () => true,
    getPatterns: () => [],
    onResult: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    onOverflow: vi.fn(),
    ...overrides,
  });
}

describe("FluencyWorker", () => {
  it("runs one analysis at a time and only while idle", async () => {
    const deferred = createDeferred<AnalysisResult>();
    const analyzer: Analyzer = { analyze: vi.fn(() => deferred.promise) };
    const onResult = vi.fn().mockResolvedValue(undefined);
    const worker = new FluencyWorker({
      analyzer, isIdle: () => true, getPatterns: () => [], onResult,
      onError: vi.fn(), onOverflow: vi.fn(),
    });
    worker.enqueue(prompt("one"));
    worker.enqueue(prompt("two"));
    const draining = worker.drain();
    void worker.drain();
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    deferred.resolve(emptyResult);
    await draining;
    expect(analyzer.analyze).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("does not start or continue analysis while busy", async () => {
    let idle = false;
    const analyzer: Analyzer = { analyze: vi.fn().mockResolvedValue(emptyResult) };
    const worker = makeWorker({ analyzer, isIdle: () => idle });
    worker.enqueue(prompt("one"));
    await worker.drain();
    expect(analyzer.analyze).not.toHaveBeenCalled();

    idle = true;
    await worker.drain();
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
  });

  it("keeps newest ten prompts and reports overflow", async () => {
    const analyzed: string[] = [];
    const onOverflow = vi.fn();
    const analyzer: Analyzer = {
      analyze: vi.fn(async (item) => {
        analyzed.push(item.prose);
        return emptyResult;
      }),
    };
    const worker = makeWorker({ analyzer, onOverflow });
    for (let index = 0; index < 12; index += 1) worker.enqueue(prompt(String(index)));
    expect(worker.getSnapshot()).toMatchObject({ queued: 10, dropped: 2 });
    expect(onOverflow).toHaveBeenNthCalledWith(1, 1);
    expect(onOverflow).toHaveBeenNthCalledWith(2, 2);
    await worker.drain();
    expect(analyzed).toEqual(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  });

  it("retries once, reports terminal errors, and continues queued work", async () => {
    vi.useFakeTimers();
    try {
      const analyzer: Analyzer = {
        analyze: vi.fn()
          .mockRejectedValueOnce(new Error("temporary"))
          .mockResolvedValueOnce(emptyResult)
          .mockRejectedValueOnce(new Error("bad one"))
          .mockRejectedValueOnce(new Error("bad two"))
          .mockResolvedValueOnce(emptyResult),
      };
      const onResult = vi.fn().mockResolvedValue(undefined);
      const onError = vi.fn();
      const worker = makeWorker({ analyzer, onResult, onError });
      worker.enqueue(prompt("retry-success"));
      worker.enqueue(prompt("terminal-failure"));
      worker.enqueue(prompt("recovered"));

      const draining = worker.drain();
      await vi.runAllTimersAsync();
      await draining;

      expect(analyzer.analyze).toHaveBeenCalledTimes(5);
      expect(onResult.mock.calls.map((call) => (call[0] as CollectedPrompt).prose))
        .toEqual(["retry-success", "recovered"]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "bad two" }));
      expect(worker.getSnapshot()).toMatchObject({ queued: 0, running: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses queue on configuration errors without retry and drains after recovery", async () => {
    let configured = false;
    const analyzer: Analyzer = {
      analyze: vi.fn(async () => {
        if (!configured) throw new AnalyzerConfigurationError("No API key");
        return emptyResult;
      }),
    };
    const onResult = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const worker = makeWorker({ analyzer, onResult, onError, maxQueue: 2 });
    worker.enqueue(prompt("blocked"));
    worker.enqueue(prompt("remaining"));

    await worker.drain();
    expect(analyzer.analyze).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(worker.getSnapshot()).toMatchObject({ queued: 2, running: false });

    configured = true;
    await worker.drain();
    expect(analyzer.analyze).toHaveBeenCalledTimes(3);
    expect(onResult.mock.calls.map((call) => (call[0] as CollectedPrompt).prose))
      .toEqual(["blocked", "remaining"]);
    expect(worker.getSnapshot()).toMatchObject({ queued: 0, running: false });
  });

  it("times out an attempt and retries it", async () => {
    vi.useFakeTimers();
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const analyzer: Analyzer = {
        analyze: vi.fn((_item, _patterns, signal) => new Promise<AnalysisResult>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (vi.mocked(analyzer.analyze).mock.calls.length === 2) resolve(emptyResult);
        })),
      };
      const worker = makeWorker({ analyzer });
      worker.enqueue(prompt("one"));
      const draining = worker.drain();
      timeout.abort(new DOMException("Timed out", "TimeoutError"));
      await vi.advanceTimersByTimeAsync(500);
      await draining;
      expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
      expect(analyzer.analyze).toHaveBeenCalledTimes(2);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("aborts and awaits active analysis on shutdown", async () => {
    const analyzer: Analyzer = {
      analyze: vi.fn((_item, _patterns, signal) => new Promise<AnalysisResult>((_, reject) =>
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))),
    };
    const worker = makeWorker({ analyzer });
    worker.enqueue(prompt("one"));
    const draining = worker.drain();
    await worker.shutdown();
    await expect(draining).resolves.toBeUndefined();
    expect(worker.getSnapshot()).toMatchObject({ queued: 0, running: false, shuttingDown: true });
  });

  it("yields between background items for foreground priority and reuses full result outside queue", async () => {
    const coordinator = new AnalyzerCoordinator();
    const firstBackground = createDeferred<AnalysisResult>();
    const backgroundAnalyzer: Analyzer = {
      analyze: vi.fn()
        .mockImplementationOnce(() => firstBackground.promise)
        .mockResolvedValueOnce(emptyResult),
    };
    const foregroundResult: AnalysisResult = {
      ...emptyResult,
      mistakes: [{
        original: "an agent", correction: "a agent", contextScope: "sentence",
        explanation: "Selected", errorType: "R:DET", patternKey: "grammar.article.rule",
        confidence: 0.95, sourceExcerpt: "an agent", correctedExcerpt: "a agent",
      }],
    };
    const foregroundAnalyzer: Analyzer = { analyze: vi.fn().mockResolvedValue(foregroundResult) };
    const onResult = vi.fn().mockResolvedValue(undefined);
    const worker = makeWorker({ coordinator, analyzer: backgroundAnalyzer, onResult });
    worker.enqueue(prompt("background-one"));
    worker.enqueue(prompt("background-two"));
    const draining = worker.drain();

    const foreground = worker.analyzeForeground({
      analyzer: foregroundAnalyzer,
      prompt: prompt("foreground"),
      patterns: [],
      deadline: Date.now() + 1_000,
    });
    firstBackground.resolve(emptyResult);
    await expect(foreground).resolves.toEqual({ kind: "success", result: foregroundResult });
    expect(foregroundAnalyzer.analyze).toHaveBeenCalledOnce();
    expect(vi.mocked(foregroundAnalyzer.analyze).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(backgroundAnalyzer.analyze).mock.invocationCallOrder[1]!);

    await draining;
    expect(backgroundAnalyzer.analyze).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("uses fresh background analyzer returned for every provider attempt", async () => {
    const first: Analyzer = { analyze: vi.fn().mockResolvedValue(emptyResult) };
    const second: Analyzer = { analyze: vi.fn().mockResolvedValue(emptyResult) };
    let configuration = { fingerprint: "one", analyzer: first };
    const getAnalyzerConfiguration = vi.fn(() => configuration);
    const worker = makeWorker({
      coordinator: new AnalyzerCoordinator(),
      analyzer: first,
      getAnalyzerConfiguration,
    });
    worker.enqueue(prompt("one"));
    await worker.drain();
    configuration = { fingerprint: "one", analyzer: second };
    worker.enqueue(prompt("same"));
    await worker.drain();
    configuration = { fingerprint: "two", analyzer: second };
    worker.enqueue(prompt("changed"));
    await worker.drain();

    expect(first.analyze).toHaveBeenCalledOnce();
    expect(second.analyze).toHaveBeenCalledTimes(2);
    expect(getAnalyzerConfiguration).toHaveBeenCalledTimes(3);
  });

  it("revalidates foreground authorization after coordinator wait before provider call", async () => {
    const coordinator = new AnalyzerCoordinator();
    const background = createDeferred<AnalysisResult>();
    const worker = makeWorker({
      coordinator,
      analyzer: { analyze: vi.fn(() => background.promise) },
    });
    worker.enqueue(prompt("background"));
    const draining = worker.drain();
    const foregroundAnalyzer: Analyzer = { analyze: vi.fn().mockResolvedValue(emptyResult) };
    const authorize = vi.fn().mockResolvedValue(false);
    const foreground = worker.analyzeForeground({
      analyzer: foregroundAnalyzer,
      prompt: prompt("foreground"),
      patterns: [],
      deadline: Date.now() + 1_000,
      authorize,
    });

    expect(authorize).not.toHaveBeenCalled();
    background.resolve(emptyResult);
    await expect(foreground).resolves.toEqual({ kind: "cancelled" });
    expect(authorize).toHaveBeenCalledOnce();
    expect(foregroundAnalyzer.analyze).not.toHaveBeenCalled();
    await draining;
  });

  it("discards an abort-ignoring background result invalidated by a foreground deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const coordinator = new AnalyzerCoordinator();
      const background = createDeferred<AnalysisResult>();
      const onResult = vi.fn().mockResolvedValue(undefined);
      const worker = makeWorker({
        coordinator,
        analyzer: { analyze: vi.fn(() => background.promise) },
        onResult,
      });
      worker.enqueue(prompt("background"));
      const draining = worker.drain();

      const foreground = worker.analyzeForeground({
        analyzer: { analyze: vi.fn().mockResolvedValue(emptyResult) },
        prompt: prompt("foreground"),
        patterns: [],
        deadline: Date.now() + 50,
      });
      await vi.advanceTimersByTimeAsync(150);
      await expect(foreground).resolves.toEqual({ kind: "busy" });
      expect(coordinator.isQuarantined()).toBe(true);

      background.resolve(emptyResult);
      await draining;
      expect(onResult).not.toHaveBeenCalled();
      expect(coordinator.isQuarantined()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a foreground result invalidated by a concurrent foreground timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const coordinator = new AnalyzerCoordinator();
      const owner = coordinator.attachOwner();
      const firstResult = createDeferred<AnalysisResult>();
      const persist = vi.fn();
      const first = coordinator.analyzeForeground({
        owner,
        analyzer: { analyze: vi.fn(() => firstResult.promise) },
        prompt: prompt("first"),
        patterns: [],
        deadline: Date.now() + 6_000,
      }).then((outcome) => {
        if (outcome.kind === "success") persist(outcome.result);
        return outcome;
      });
      const second = coordinator.analyzeForeground({
        owner,
        analyzer: { analyze: vi.fn().mockResolvedValue(emptyResult) },
        prompt: prompt("second"),
        patterns: [],
        deadline: Date.now() + 50,
      });

      await vi.advanceTimersByTimeAsync(150);
      await expect(second).resolves.toEqual({ kind: "busy" });
      firstResult.resolve(emptyResult);
      await expect(first).resolves.toEqual({ kind: "cancelled" });
      expect(persist).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes foreground deadline timers and cancellation listeners after success", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new AnalyzerCoordinator();
      const owner = coordinator.attachOwner();
      const cancellation = new AbortController();
      const addListener = vi.spyOn(cancellation.signal, "addEventListener");
      const removeListener = vi.spyOn(cancellation.signal, "removeEventListener");

      await expect(coordinator.analyzeForeground({
        owner,
        analyzer: { analyze: vi.fn().mockResolvedValue(emptyResult) },
        prompt: prompt("clean"),
        patterns: [],
        deadline: Date.now() + 6_000,
        signal: cancellation.signal,
      })).resolves.toEqual({ kind: "success", result: emptyResult });

      expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      const ownerState = (coordinator as unknown as {
        owners: Map<symbol, { revocationListeners: Set<() => void> }>;
      }).owners.get(owner.token);
      expect(ownerState?.revocationListeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds abort-ignoring foreground calls, quarantines overlap, and clears on settlement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const coordinator = new AnalyzerCoordinator();
      const owner = coordinator.attachOwner();
      const hung = createDeferred<AnalysisResult>();
      const analyzer: Analyzer = { analyze: vi.fn(() => hung.promise) };
      const outcome = coordinator.analyzeForeground({
        owner,
        analyzer,
        prompt: prompt("hung"),
        patterns: [],
        deadline: Date.now() + 6_000,
      });

      await vi.advanceTimersByTimeAsync(6_100);
      await expect(outcome).resolves.toEqual({ kind: "timeout" });
      expect(coordinator.isQuarantined()).toBe(true);
      const nextOwner = coordinator.attachOwner();
      await expect(coordinator.analyzeForeground({
        owner: nextOwner,
        analyzer: { analyze: vi.fn().mockResolvedValue(emptyResult) },
        prompt: prompt("next"),
        patterns: [],
        deadline: Date.now() + 6_000,
      })).resolves.toEqual({ kind: "quarantined" });

      hung.resolve(emptyResult);
      await Promise.resolve();
      await Promise.resolve();
      expect(coordinator.isQuarantined()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes only shutting-down owner and discards its late result across reload", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new AnalyzerCoordinator();
      const oldOwner = coordinator.attachOwner();
      const hung = createDeferred<AnalysisResult>();
      const oldOutcome = coordinator.analyzeForeground({
        owner: oldOwner,
        analyzer: { analyze: vi.fn(() => hung.promise) },
        prompt: prompt("old"),
        patterns: [],
        deadline: Date.now() + 6_000,
      });
      const shutdown = coordinator.shutdownOwner(oldOwner);
      await vi.advanceTimersByTimeAsync(100);
      await shutdown;
      await expect(oldOutcome).resolves.toEqual({ kind: "shutdown" });
      expect(coordinator.isQuarantined()).toBe(true);

      const newOwner = coordinator.attachOwner();
      await expect(coordinator.analyzeForeground({
        owner: newOwner,
        analyzer: { analyze: vi.fn().mockResolvedValue(emptyResult) },
        prompt: prompt("new"),
        patterns: [],
        deadline: Date.now() + 1_000,
      })).resolves.toEqual({ kind: "quarantined" });
      hung.resolve(emptyResult);
      await Promise.resolve();
      await Promise.resolve();
      expect(coordinator.isQuarantined()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears active state when callbacks fail so later drains recover", async () => {
    const onResult = vi.fn().mockRejectedValueOnce(new Error("write failed")).mockResolvedValue(undefined);
    const onError = vi.fn(() => { throw new Error("error callback failed"); });
    const worker = makeWorker({ onResult, onError });
    worker.enqueue(prompt("one"));
    worker.enqueue(prompt("two"));

    await expect(worker.drain()).rejects.toThrow("error callback failed");
    expect(worker.getSnapshot()).toMatchObject({ queued: 1, running: false });
    await worker.drain();
    expect(worker.getSnapshot()).toMatchObject({ queued: 0, running: false });
  });
});
