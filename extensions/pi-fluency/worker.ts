import { AnalyzerConfigurationError, type Analyzer } from "./analyzer.js";
import type { AnalysisResult, CollectedPrompt, MistakePattern } from "./types.js";

export interface WorkerSnapshot {
  queued: number;
  dropped: number;
  running: boolean;
  shuttingDown: boolean;
}

export interface WorkerOptions {
  analyzer: Analyzer;
  isIdle: () => boolean;
  getPatterns: () => MistakePattern[];
  onResult: (prompt: CollectedPrompt, result: AnalysisResult) => Promise<void>;
  onError: (error: Error) => void;
  onOverflow: (dropped: number) => void;
  maxQueue?: number;
}

const DEFAULT_MAX_QUEUE = 10;
const ANALYSIS_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 500;

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export class FluencyWorker {
  private readonly queue: CollectedPrompt[] = [];
  private readonly maxQueue: number;
  private controller: AbortController | undefined;
  private active: Promise<void> | undefined;
  private dropped = 0;
  private shuttingDown = false;

  constructor(private readonly options: WorkerOptions) {
    this.maxQueue = Number.isSafeInteger(options.maxQueue) && (options.maxQueue ?? -1) >= 0
      ? options.maxQueue as number
      : DEFAULT_MAX_QUEUE;
  }

  enqueue(prompt: CollectedPrompt): void {
    if (this.shuttingDown) return;
    this.queue.push(prompt);
    while (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
      this.options.onOverflow(this.dropped);
    }
  }

  async drain(): Promise<void> {
    if (this.active || this.shuttingDown || !this.options.isIdle()) return this.active;
    this.active = this.run().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.queue.length = 0;
    this.controller?.abort();
    await this.active?.catch(() => undefined);
  }

  getSnapshot(): WorkerSnapshot {
    return {
      queued: this.queue.length,
      dropped: this.dropped,
      running: this.active !== undefined,
      shuttingDown: this.shuttingDown,
    };
  }

  private async run(): Promise<void> {
    while (!this.shuttingDown && this.options.isIdle()) {
      const prompt = this.queue.shift();
      if (!prompt) return;
      try {
        const result = await this.analyzeWithRetry(prompt);
        await this.options.onResult(prompt, result);
      } catch (error) {
        if (!this.shuttingDown) {
          const normalized = normalizeError(error);
          if (normalized instanceof AnalyzerConfigurationError) {
            this.queue.unshift(prompt);
            this.options.onError(normalized);
            return;
          }
          this.options.onError(normalized);
        }
      } finally {
        this.controller = undefined;
      }
    }
  }

  private async analyzeWithRetry(prompt: CollectedPrompt): Promise<AnalysisResult> {
    let lastError: Error | undefined;
    for (const delayMs of [0, RETRY_DELAY_MS]) {
      if (this.shuttingDown) throw new DOMException("Aborted", "AbortError");
      if (delayMs > 0) {
        const signal = this.controller?.signal;
        if (!signal) throw new Error("Analysis retry lost abort controller");
        await abortableDelay(delayMs, signal);
      }
      if (this.shuttingDown) throw new DOMException("Aborted", "AbortError");

      this.controller = new AbortController();
      const signal = AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
      ]);
      try {
        return await this.options.analyzer.analyze(prompt, this.options.getPatterns(), signal);
      } catch (error) {
        const normalized = normalizeError(error);
        if (
          normalized.name === "AbortError"
          || this.shuttingDown
          || normalized instanceof AnalyzerConfigurationError
        ) throw normalized;
        lastError = normalized;
      }
    }
    throw lastError ?? new Error("Analysis failed");
  }
}
