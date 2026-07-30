import { describe, expect, it, vi } from "vitest";
import { AnalyzerConfigurationError, type Analyzer } from "../extensions/pi-fluency/analyzer.js";
import { FluencyWorker, type WorkerOptions } from "../extensions/pi-fluency/worker.js";
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
