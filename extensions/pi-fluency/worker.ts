import { AnalyzerConfigurationError, type Analyzer } from "./analyzer.js";
import type { AnalysisResult, CollectedPrompt, MistakePattern, PracticeTarget } from "./types.js";

export interface WorkerSnapshot {
  queued: number;
  dropped: number;
  running: boolean;
  shuttingDown: boolean;
}

export interface AnalyzerCoordinatorOwner {
  readonly token: symbol;
}

interface OwnerState {
  revoked: boolean;
  revokedPromise: Promise<void>;
  revoke: () => void;
}

interface SettledAnalysis<T> {
  ok: boolean;
  value?: T;
  error?: Error;
}

interface ActiveAnalysis<T = unknown> {
  requestToken: symbol;
  ownerToken: symbol;
  controller: AbortController;
  settlement: Promise<SettledAnalysis<T>>;
  settled: boolean;
}

export type ForegroundAnalysisOutcome =
  | { kind: "success"; result: AnalysisResult }
  | { kind: "busy" | "timeout" | "cancelled" | "quarantined" | "shutdown" }
  | { kind: "error"; error: Error };

export interface ForegroundAnalysisOptions {
  owner: AnalyzerCoordinatorOwner;
  analyzer: Analyzer;
  prompt: CollectedPrompt;
  patterns: MistakePattern[];
  selectedTargets?: readonly PracticeTarget[];
  /** Absolute epoch deadline. */
  deadline: number;
  signal?: AbortSignal;
  abortGraceMs?: number;
}

export class AnalyzerCoordinatorUnavailableError extends Error {
  override readonly name = "AnalyzerCoordinatorUnavailableError";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

/** Process-local serializer. State contains no extension callbacks, stores, or UI contexts. */
export class AnalyzerCoordinator {
  private readonly owners = new Map<symbol, OwnerState>();
  private active: ActiveAnalysis | undefined;
  private foregroundPending = 0;
  private quarantined = false;
  private readonly waiters = new Set<() => void>();

  attachOwner(): AnalyzerCoordinatorOwner {
    const token = Symbol("pi-fluency-analyzer-owner");
    let revoke!: () => void;
    const revokedPromise = new Promise<void>((resolve) => { revoke = resolve; });
    this.owners.set(token, { revoked: false, revokedPromise, revoke });
    return { token };
  }

  isQuarantined(): boolean {
    return this.quarantined;
  }

  canAcceptBackground(owner: AnalyzerCoordinatorOwner): boolean {
    return this.isCurrentOwner(owner) && !this.quarantined;
  }

  private isCurrentOwner(owner: AnalyzerCoordinatorOwner): boolean {
    return this.owners.get(owner.token)?.revoked === false;
  }

  private changed(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  private waitForChange(maximumMs?: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      this.waiters.add(finish);
      if (maximumMs !== undefined) timer = setTimeout(finish, Math.max(0, maximumMs));
    });
  }

  private start<T>(owner: AnalyzerCoordinatorOwner, task: (signal: AbortSignal) => Promise<T>): ActiveAnalysis<T> {
    if (this.active) throw new Error("Analyzer coordinator overlap");
    const controller = new AbortController();
    const requestToken = Symbol("pi-fluency-analyzer-request");
    const active: ActiveAnalysis<T> = {
      requestToken,
      ownerToken: owner.token,
      controller,
      settled: false,
      settlement: undefined as unknown as Promise<SettledAnalysis<T>>,
    };
    let taskPromise: Promise<T>;
    try {
      taskPromise = task(controller.signal);
    } catch (error) {
      taskPromise = Promise.reject(error);
    }
    active.settlement = taskPromise.then(
      (value): SettledAnalysis<T> => ({ ok: true, value }),
      (error): SettledAnalysis<T> => ({ ok: false, error: normalizeError(error) }),
    )
      .finally(() => {
        active.settled = true;
        if (this.active?.requestToken === requestToken) this.active = undefined;
        this.quarantined = false;
        this.changed();
      });
    this.active = active as ActiveAnalysis;
    this.changed();
    return active;
  }

  private ownerRevoked(owner: AnalyzerCoordinatorOwner): Promise<"revoked"> {
    const state = this.owners.get(owner.token);
    if (!state || state.revoked) return Promise.resolve("revoked");
    return state.revokedPromise.then(() => "revoked" as const);
  }

  async runBackground<T>(
    owner: AnalyzerCoordinatorOwner,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    while (true) {
      if (!this.isCurrentOwner(owner)) throw new DOMException("Aborted", "AbortError");
      if (this.quarantined) throw new AnalyzerCoordinatorUnavailableError("Analyzer coordinator quarantined");
      if (this.active || this.foregroundPending > 0) {
        await Promise.race([this.waitForChange(), this.ownerRevoked(owner)]);
        continue;
      }
      const active = this.start(owner, task);
      const settled = await Promise.race([active.settlement, this.ownerRevoked(owner)]);
      if (settled === "revoked") throw new DOMException("Aborted", "AbortError");
      if (!this.isCurrentOwner(owner)) throw new DOMException("Aborted", "AbortError");
      if (settled.ok) return settled.value as T;
      throw settled.error ?? new Error("Analysis failed");
    }
  }

  private async abortWithGrace(active: ActiveAnalysis, graceMs: number): Promise<boolean> {
    active.controller.abort(new DOMException("Aborted", "AbortError"));
    if (active.settled) return true;
    await Promise.race([active.settlement.then(() => undefined), delay(graceMs)]);
    if (!active.settled) {
      this.quarantined = true;
      this.changed();
      return false;
    }
    return true;
  }

  async analyzeForeground(options: ForegroundAnalysisOptions): Promise<ForegroundAnalysisOutcome> {
    const graceMs = Math.max(0, Math.min(100, options.abortGraceMs ?? 100));
    if (!Number.isFinite(options.deadline)) return { kind: "error", error: new Error("Invalid analysis deadline") };
    if (!this.isCurrentOwner(options.owner)) return { kind: "shutdown" };
    if (this.quarantined) return { kind: "quarantined" };
    this.foregroundPending += 1;
    this.changed();
    try {
      while (this.active) {
        if (options.signal?.aborted) {
          const active = this.active;
          if (active) await this.abortWithGrace(active, graceMs);
          return { kind: "cancelled" };
        }
        const remaining = options.deadline - Date.now();
        if (remaining <= 0) {
          const active = this.active;
          if (active) await this.abortWithGrace(active, graceMs);
          return { kind: "busy" };
        }
        await Promise.race([
          this.waitForChange(remaining),
          options.signal === undefined
            ? new Promise<never>(() => undefined)
            : new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => resolve(), { once: true })),
        ]);
      }
      if (!this.isCurrentOwner(options.owner)) return { kind: "shutdown" };
      if (this.quarantined) return { kind: "quarantined" };
      if (options.signal?.aborted) return { kind: "cancelled" };
      if (Date.now() >= options.deadline) return { kind: "timeout" };

      const active = this.start(options.owner, (signal) => options.analyzer.analyze(
        options.prompt,
        options.patterns,
        signal,
        options.selectedTargets,
      ));
      const remaining = Math.max(0, options.deadline - Date.now());
      const deadlineRace = delay(remaining).then(() => "deadline" as const);
      const cancelRace = options.signal === undefined
        ? new Promise<never>(() => undefined)
        : new Promise<"cancel">((resolve) => options.signal!.addEventListener("abort", () => resolve("cancel"), { once: true }));
      const outcome = await Promise.race([active.settlement, deadlineRace, cancelRace, this.ownerRevoked(options.owner)]);
      if (outcome === "deadline" || outcome === "cancel" || outcome === "revoked") {
        await this.abortWithGrace(active, graceMs);
        if (outcome === "cancel") return { kind: "cancelled" };
        if (outcome === "revoked") return { kind: "shutdown" };
        return { kind: "timeout" };
      }
      if (!this.isCurrentOwner(options.owner)) return { kind: "shutdown" };
      if (outcome.ok) return { kind: "success", result: outcome.value as AnalysisResult };
      return { kind: "error", error: outcome.error ?? new Error("Analysis failed") };
    } finally {
      this.foregroundPending -= 1;
      this.changed();
    }
  }

  async shutdownOwner(owner: AnalyzerCoordinatorOwner, abortGraceMs = 100): Promise<void> {
    const state = this.owners.get(owner.token);
    if (!state || state.revoked) return;
    state.revoked = true;
    state.revoke();
    this.owners.delete(owner.token);
    this.changed();
    const active = this.active;
    if (active?.ownerToken === owner.token) {
      await this.abortWithGrace(active, Math.max(0, Math.min(100, abortGraceMs)));
    }
  }
}

const COORDINATOR_SYMBOL = Symbol.for("pi-fluency.analyzer-coordinator.v1");
interface GlobalCoordinatorSlot { version: 1; coordinator: AnalyzerCoordinator }

export function getProcessAnalyzerCoordinator(): AnalyzerCoordinator {
  const globals = globalThis as typeof globalThis & { [COORDINATOR_SYMBOL]?: GlobalCoordinatorSlot };
  const current = globals[COORDINATOR_SYMBOL];
  if (current?.version === 1
    && typeof current.coordinator?.attachOwner === "function"
    && typeof current.coordinator?.analyzeForeground === "function"
    && typeof current.coordinator?.runBackground === "function") return current.coordinator;
  const coordinator = new AnalyzerCoordinator();
  globals[COORDINATOR_SYMBOL] = { version: 1, coordinator };
  return coordinator;
}

export interface WorkerAnalyzerConfiguration {
  fingerprint: string;
  analyzer: Analyzer;
}

export interface WorkerOptions {
  analyzer: Analyzer;
  /** Fresh request-scoped resolver. Worker replaces cached analyzer only when fingerprint changes. */
  getAnalyzerConfiguration?: () => WorkerAnalyzerConfiguration;
  isIdle: () => boolean;
  getPatterns: () => MistakePattern[];
  onResult: (prompt: CollectedPrompt, result: AnalysisResult) => Promise<void>;
  onError: (error: Error) => void;
  onOverflow: (dropped: number) => void;
  maxQueue?: number;
  coordinator?: AnalyzerCoordinator;
}

const DEFAULT_MAX_QUEUE = 10;
const ANALYSIS_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 500;

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
  private readonly coordinator: AnalyzerCoordinator;
  private readonly owner: AnalyzerCoordinatorOwner;
  private controller: AbortController | undefined;
  private active: Promise<void> | undefined;
  private dropped = 0;
  private shuttingDown = false;
  private analyzerConfiguration: WorkerAnalyzerConfiguration;

  constructor(private readonly options: WorkerOptions) {
    this.maxQueue = Number.isSafeInteger(options.maxQueue) && (options.maxQueue ?? -1) >= 0
      ? options.maxQueue as number
      : DEFAULT_MAX_QUEUE;
    this.coordinator = options.coordinator ?? getProcessAnalyzerCoordinator();
    this.owner = this.coordinator.attachOwner();
    this.analyzerConfiguration = { fingerprint: "legacy-static-analyzer", analyzer: options.analyzer };
  }

  enqueue(prompt: CollectedPrompt): void {
    if (this.shuttingDown || !this.coordinator.canAcceptBackground(this.owner)) return;
    this.queue.push(prompt);
    while (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
      this.options.onOverflow(this.dropped);
    }
  }

  analyzeForeground(options: Omit<ForegroundAnalysisOptions, "owner">): Promise<ForegroundAnalysisOutcome> {
    return this.coordinator.analyzeForeground({ ...options, owner: this.owner });
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
    await this.coordinator.shutdownOwner(this.owner);
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
        if (!this.shuttingDown) await this.options.onResult(prompt, result);
      } catch (error) {
        if (!this.shuttingDown) {
          const normalized = normalizeError(error);
          if (normalized instanceof AnalyzerCoordinatorUnavailableError) {
            this.queue.length = 0;
            this.options.onError(normalized);
            return;
          }
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
      await Promise.resolve();
    }
  }

  private async analyzeWithRetry(prompt: CollectedPrompt): Promise<AnalysisResult> {
    let lastError: Error | undefined;
    for (const delayMs of [0, RETRY_DELAY_MS]) {
      if (this.shuttingDown) throw new DOMException("Aborted", "AbortError");
      this.controller = new AbortController();
      if (delayMs > 0) await abortableDelay(delayMs, this.controller.signal);
      if (this.shuttingDown) throw new DOMException("Aborted", "AbortError");

      const timeoutSignal = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
      try {
        const fresh = this.options.getAnalyzerConfiguration?.();
        if (fresh !== undefined && fresh.fingerprint !== this.analyzerConfiguration.fingerprint) {
          this.analyzerConfiguration = fresh;
        }
        return await this.coordinator.runBackground(this.owner, (coordinatorSignal) => this.analyzerConfiguration.analyzer.analyze(
          prompt,
          this.options.getPatterns(),
          AbortSignal.any([this.controller!.signal, timeoutSignal, coordinatorSignal]),
        ));
      } catch (error) {
        const normalized = normalizeError(error);
        if (
          normalized.name === "AbortError"
          || this.shuttingDown
          || normalized instanceof AnalyzerConfigurationError
          || normalized instanceof AnalyzerCoordinatorUnavailableError
        ) throw normalized;
        lastError = normalized;
      }
    }
    throw lastError ?? new Error("Analysis failed");
  }
}
