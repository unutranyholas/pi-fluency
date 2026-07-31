import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lock, type LockOptions } from "proper-lockfile";
import {
  DEFAULT_SETTINGS,
  HISTORY_SCHEMA_VERSION,
  PRACTICE_SCHEMA_VERSION,
  SCHEMA_VERSION,
  type AnalysisResult,
  type CollectedPrompt,
  type FluencyAnalyticsSnapshot,
  type FluencyEvent,
  type FluencySettings,
  type FluencyState,
  type MistakePattern,
  type PracticePolicySnapshot,
  type PracticeSettings,
  type PracticeTarget,
  type ReviewPattern,
} from "./types.js";
import {
  ERRANT_CATEGORIES,
  errantCategory,
  type ErrantCategory,
} from "./taxonomy.js";
import { countEnglishWords } from "./analytics.js";
import {
  HistorySchemaMismatchError,
  decodeHistoryLine,
  encodeHistoryEvent,
} from "./history-codec.js";
import {
  copyAnalysisResult,
  copyObservation,
  copyOccurrence,
  copyPattern,
  createFluencyState,
  reduceHistoryEvent,
  replaceFluencyState,
} from "./state-reducer.js";
import { buildRetainedSnapshot } from "./retention.js";
import {
  decodeHistoryGenerationMarker,
  encodeHistoryGenerationMarker,
} from "./generation-marker.js";
import {
  FIVE_HOURS_MS,
  canonicalizePracticeTargets,
  copyPracticeSettings,
  decodePracticeSettings,
  defaultPracticeSettings,
} from "./practice-settings.js";

const HISTORY_SCHEMA_WARNING = "History migration required; run /fluency clear";
const HISTORY_GENERATION_FILE = "history-generation";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_UPDATE_INTERVAL_MS = 10_000;
const LOCK_RETRIES = {
  retries: 60,
  factor: 1.2,
  minTimeout: 100,
  maxTimeout: 1_000,
  randomize: true,
} as const;

type LockProvider = (file: string, options: LockOptions) => Promise<() => Promise<void>>;
type FileReplacer = (temporary: string, destination: string) => Promise<void>;
type PolicyFileReader = (path: string) => Promise<string>;

const errantCategorySet = new Set<string>(ERRANT_CATEGORIES);

function copySettings(settings: FluencySettings): FluencySettings {
  return {
    ...settings,
    ignoredPatternKeys: [...settings.ignoredPatternKeys],
    ignoredCategories: [...settings.ignoredCategories],
  };
}

function copySettingsPatch(patch: unknown): Partial<FluencySettings> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid settings");
  const raw = patch as Record<string, unknown>;
  if (raw.ignoredPatternKeys !== undefined && !Array.isArray(raw.ignoredPatternKeys)) throw new Error("Invalid settings");
  if (raw.ignoredCategories !== undefined && !Array.isArray(raw.ignoredCategories)) throw new Error("Invalid settings");
  return {
    ...(patch as Partial<FluencySettings>),
    ...(raw.ignoredPatternKeys === undefined ? {} : { ignoredPatternKeys: [...raw.ignoredPatternKeys] as string[] }),
    ...(raw.ignoredCategories === undefined ? {} : { ignoredCategories: [...raw.ignoredCategories] as ErrantCategory[] }),
  };
}

function decodeSettings(value: unknown): FluencySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings");
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== SCHEMA_VERSION
    || "ignoredClassIds" in raw
    || typeof raw.enabled !== "boolean"
    || typeof raw.minimumConfidence !== "number"
    || !Number.isFinite(raw.minimumConfidence)
    || raw.minimumConfidence < 0
    || raw.minimumConfidence > 1
    || typeof raw.retentionLimit !== "number"
    || !Number.isInteger(raw.retentionLimit)
    || raw.retentionLimit < 0
    || !Array.isArray(raw.ignoredPatternKeys)
    || raw.ignoredPatternKeys.some((item) => typeof item !== "string" || item.length === 0)
    || !Array.isArray(raw.ignoredCategories)
    || raw.ignoredCategories.some((item) => typeof item !== "string" || !errantCategorySet.has(item))
    || (raw.consentedAt !== undefined && (typeof raw.consentedAt !== "number" || !Number.isFinite(raw.consentedAt)))
    || (raw.provider !== undefined && (typeof raw.provider !== "string" || raw.provider.length === 0))
    || (raw.modelId !== undefined && (typeof raw.modelId !== "string" || raw.modelId.length === 0))
  ) throw new Error("Invalid settings");
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: raw.enabled,
    minimumConfidence: raw.minimumConfidence,
    retentionLimit: raw.retentionLimit,
    ignoredPatternKeys: [...new Set(raw.ignoredPatternKeys as string[])],
    ignoredCategories: [...new Set(raw.ignoredCategories as ErrantCategory[])],
    ...(raw.consentedAt === undefined ? {} : { consentedAt: raw.consentedAt as number }),
    ...(raw.provider === undefined ? {} : { provider: raw.provider as string }),
    ...(raw.modelId === undefined ? {} : { modelId: raw.modelId as string }),
  };
}

export class FluencyStore {
  private static lockProvider: LockProvider = lock;
  private static settingsFileReplacer: FileReplacer = rename;
  private static practiceFileReplacer: FileReplacer = rename;
  private static historyFileReplacer: FileReplacer = rename;
  private static policyFileReader: PolicyFileReader = (path) => readFile(path, "utf8");

  private readonly state = createFluencyState();
  private readonly warnings: string[] = [];
  private readonly pendingEvents: Array<{ generation: string; event: FluencyEvent }> = [];
  private historyGeneration = "";
  private eventsSinceCompact = 0;
  private historyResetRequired = false;
  private settings: FluencySettings = copySettings(DEFAULT_SETTINGS);
  private practice: PracticeSettings = defaultPracticeSettings();
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly rootDir: string,
    private readonly historyPath: string,
    private readonly settingsPath: string,
    private readonly practicePath: string,
    private readonly historyGenerationPath: string,
  ) {}

  static async open(rootDir: string): Promise<FluencyStore> {
    await mkdir(rootDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(rootDir, PRIVATE_DIRECTORY_MODE);
    const store = new FluencyStore(
      rootDir,
      join(rootDir, "history.jsonl"),
      join(rootDir, "settings.json"),
      join(rootDir, "practice.json"),
      join(rootDir, HISTORY_GENERATION_FILE),
    );
    await store.withGlobalLock(async (signal) => {
      await store.hardenExistingFiles();
      await store.refreshFromDiskUnsafe(true, signal);
      await store.hardenExistingFiles();
    });
    return store;
  }

  getAnalyticsSnapshot(): FluencyAnalyticsSnapshot {
    return {
      observations: [...this.state.observations.values()].map(copyObservation),
      occurrences: [...this.state.occurrences.values()].map(copyOccurrence),
      patterns: [...this.state.patterns.values()].map(copyPattern),
      ignoredPatternKeys: [...this.settings.ignoredPatternKeys],
      ignoredCategories: [...this.settings.ignoredCategories],
    };
  }

  hasProcessedPromptHash(promptHash: string): boolean {
    return this.state.processedPromptHashes.has(promptHash);
  }

  requiresHistoryReset(): boolean { return this.historyResetRequired; }
  getSettings(): FluencySettings { return copySettings(this.settings); }
  getPracticeSettings(): PracticeSettings { return copyPracticeSettings(this.practice); }
  getWarnings(): string[] { return [...this.warnings]; }

  private async hardenExistingFiles(): Promise<void> {
    for (const path of [this.historyPath, this.settingsPath, this.practicePath, this.historyGenerationPath]) {
      try {
        await chmod(path, PRIVATE_FILE_MODE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private enqueueMutation<T>(mutation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(() => this.withGlobalLock(async (signal) => {
      await this.refreshFromDiskUnsafe(false, signal);
      signal.throwIfAborted();
      return mutation(signal);
    }));
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withGlobalLock<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let compromiseError: Error | undefined;
    const release = await FluencyStore.lockProvider(this.rootDir, {
      realpath: false,
      stale: LOCK_STALE_AFTER_MS,
      update: LOCK_UPDATE_INTERVAL_MS,
      retries: LOCK_RETRIES,
      onCompromised: (error) => {
        compromiseError ??= error;
        controller.abort(compromiseError);
      },
    });

    let value: T | undefined;
    let primaryError: unknown;
    try {
      value = await operation(controller.signal);
      controller.signal.throwIfAborted();
    } catch (error) {
      primaryError = compromiseError ?? error;
    }

    try {
      await release();
    } catch (releaseError) {
      const expectedCompromiseRelease = compromiseError !== undefined &&
        (releaseError as NodeJS.ErrnoException).code === "ERELEASED";
      if (primaryError === undefined && !expectedCompromiseRelease) throw releaseError;
    }

    if (compromiseError !== undefined) throw compromiseError;
    if (primaryError !== undefined) throw primaryError;
    return value as T;
  }

  private async writeHistoryGenerationUnsafe(
    generation: string,
    resetPending: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const temporary = `${this.historyGenerationPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, encodeHistoryGenerationMarker({ generation, resetPending }), {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
      signal,
    });
    signal.throwIfAborted();
    await rename(temporary, this.historyGenerationPath);
    signal.throwIfAborted();
  }

  private async replaceHistoryWithEmptyUnsafe(signal: AbortSignal): Promise<void> {
    const temporary = `${this.historyPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, "", { encoding: "utf8", mode: PRIVATE_FILE_MODE, signal });
    signal.throwIfAborted();
    await FluencyStore.historyFileReplacer(temporary, this.historyPath);
    signal.throwIfAborted();
  }

  private async readHistoryGenerationUnsafe(signal: AbortSignal): Promise<string> {
    let generation: string;
    let resetPending = false;
    try {
      const marker = decodeHistoryGenerationMarker(
        await readFile(this.historyGenerationPath, { encoding: "utf8", signal }),
      );
      signal.throwIfAborted();
      generation = marker.generation;
      resetPending = marker.resetPending;
      if (marker.legacy) await this.writeHistoryGenerationUnsafe(generation, false, signal);
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      generation = randomUUID();
      await this.writeHistoryGenerationUnsafe(generation, false, signal);
    }
    if (resetPending) {
      await this.replaceHistoryWithEmptyUnsafe(signal);
      await this.writeHistoryGenerationUnsafe(generation, false, signal);
    }
    return generation;
  }

  private async refreshFromDiskUnsafe(recordWarnings: boolean, signal: AbortSignal): Promise<void> {
    const diskGeneration = await this.readHistoryGenerationUnsafe(signal);
    for (let index = this.pendingEvents.length - 1; index >= 0; index -= 1) {
      if (this.pendingEvents[index]!.generation !== diskGeneration) this.pendingEvents.splice(index, 1);
    }
    this.historyGeneration = diskGeneration;

    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, { encoding: "utf8", signal })) as unknown;
      signal.throwIfAborted();
      this.settings = decodeSettings(parsed);
    } catch (error) {
      signal.throwIfAborted();
      this.settings = copySettings(DEFAULT_SETTINGS);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && recordWarnings) {
        this.warnings.push("Could not read settings; defaults loaded");
      }
    }

    try {
      const parsed = JSON.parse(await readFile(this.practicePath, { encoding: "utf8", signal })) as unknown;
      signal.throwIfAborted();
      this.practice = decodePracticeSettings(parsed);
    } catch (error) {
      signal.throwIfAborted();
      this.practice = defaultPracticeSettings();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && recordWarnings) {
        this.warnings.push("Could not read practice settings; defaults loaded");
      }
    }

    let history: string;
    try {
      history = await readFile(this.historyPath, { encoding: "utf8", signal });
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        signal.throwIfAborted();
        await writeFile(this.historyPath, "", { encoding: "utf8", mode: PRIVATE_FILE_MODE, signal });
        signal.throwIfAborted();
        history = "";
      } else {
        throw error;
      }
    }

    const refreshed = createFluencyState();
    let corrupt = 0;
    let eventsSinceCompact = 0;
    for (const line of history.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = decodeHistoryLine(JSON.parse(line) as unknown);
        reduceHistoryEvent(refreshed, event);
        eventsSinceCompact = event.type === "snapshot" ? 0 : eventsSinceCompact + 1;
      } catch (error) {
        if (error instanceof HistorySchemaMismatchError) {
          this.historyResetRequired = true;
          if (!this.warnings.includes(HISTORY_SCHEMA_WARNING)) this.warnings.push(HISTORY_SCHEMA_WARNING);
          replaceFluencyState(this.state, createFluencyState());
          this.eventsSinceCompact = 0;
          return;
        }
        corrupt += 1;
      }
    }
    this.historyResetRequired = false;
    for (let index = this.warnings.indexOf(HISTORY_SCHEMA_WARNING); index >= 0; index = this.warnings.indexOf(HISTORY_SCHEMA_WARNING)) {
      this.warnings.splice(index, 1);
    }
    for (const pending of this.pendingEvents) reduceHistoryEvent(refreshed, pending.event);
    signal.throwIfAborted();
    replaceFluencyState(this.state, refreshed);
    this.eventsSinceCompact = eventsSinceCompact + this.pendingEvents.length;
    if (recordWarnings && corrupt > 0) {
      this.warnings.push(`Skipped ${corrupt} corrupt history ${corrupt === 1 ? "line" : "lines"}`);
    }
  }

  private isIgnored(pattern: MistakePattern): boolean {
    return this.settings.ignoredPatternKeys.includes(pattern.patternKey) ||
      this.settings.ignoredCategories.includes(errantCategory(pattern.errorType));
  }

  listReviewPatterns(): ReviewPattern[] {
    const counts = new Map<string, {
      pendingCount: number;
      acceptedCount: number;
      dismissedCount: number;
    }>();
    for (const occurrence of this.state.occurrences.values()) {
      const current = counts.get(occurrence.patternId) ?? {
        pendingCount: 0,
        acceptedCount: 0,
        dismissedCount: 0,
      };
      if (occurrence.decision === "pending") current.pendingCount += 1;
      else if (occurrence.decision === "accepted") current.acceptedCount += 1;
      else current.dismissedCount += 1;
      counts.set(occurrence.patternId, current);
    }

    return [...this.state.patterns.values()]
      .map((pattern) => ({
        ...pattern,
        ...(counts.get(pattern.id) ?? {
          pendingCount: 0,
          acceptedCount: 0,
          dismissedCount: 0,
        }),
      }))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  }

  listInbox(): ReviewPattern[] {
    return this.listReviewPatterns()
      .filter((pattern) => pattern.pendingCount > 0 && !this.isIgnored(pattern));
  }

  listAccepted(): ReviewPattern[] {
    return this.listReviewPatterns()
      .filter((pattern) => pattern.acceptedCount > 0 && !this.isIgnored(pattern));
  }

  listIgnored(): ReviewPattern[] {
    return this.listReviewPatterns().filter((pattern) => this.isIgnored(pattern));
  }

  listKnownPatterns(): MistakePattern[] {
    return this.listReviewPatterns()
      .filter((pattern) => !this.isIgnored(pattern) && (pattern.pendingCount > 0 || pattern.acceptedCount > 0))
      .map(({ pendingCount: _pending, acceptedCount: _accepted, dismissedCount: _dismissed, ...pattern }) => pattern);
  }

  ignorePatternKey(patternKey: string): Promise<void> {
    return this.updateSettings((settings) => ({
      ignoredPatternKeys: [...new Set([...settings.ignoredPatternKeys, patternKey])],
    }));
  }

  ignoreCategory(category: ErrantCategory): Promise<void> {
    return this.updateSettings((settings) => ({
      ignoredCategories: [...new Set([...settings.ignoredCategories, category])],
    }));
  }

  /** Restore every applicable ignore in one queued settings mutation and atomic file replacement. */
  restoreIgnoreTargets(targets: {
    patternKeys: readonly string[];
    categories: readonly ErrantCategory[];
  }): Promise<void> {
    const patternKeys = new Set(targets.patternKeys);
    const categories = new Set(targets.categories);
    return this.updateSettings((settings) => ({
      ignoredPatternKeys: settings.ignoredPatternKeys.filter((value) => !patternKeys.has(value)),
      ignoredCategories: settings.ignoredCategories.filter((value) => !categories.has(value)),
    }));
  }

  /** Read one stable settings/practice pair without taking the mutation lock. */
  async getFreshPolicySnapshot(deadline: number): Promise<PracticePolicySnapshot> {
    if (!Number.isFinite(deadline)) throw new Error("Invalid practice policy deadline");
    const readOptional = async (path: string): Promise<string | undefined> => {
      if (Date.now() >= deadline) throw new Error("Practice policy read deadline exceeded");
      try {
        const value = await FluencyStore.policyFileReader(path);
        if (Date.now() >= deadline) throw new Error("Practice policy read deadline exceeded");
        return value;
      } catch (error) {
        if (Date.now() >= deadline) throw new Error("Practice policy read deadline exceeded");
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    };

    while (Date.now() < deadline) {
      const settingsFirst = await readOptional(this.settingsPath);
      const practiceFirst = await readOptional(this.practicePath);
      const settingsSecond = await readOptional(this.settingsPath);
      const practiceSecond = await readOptional(this.practicePath);
      if (settingsFirst !== settingsSecond || practiceFirst !== practiceSecond) continue;

      let settings = copySettings(DEFAULT_SETTINGS);
      let practice = defaultPracticeSettings();
      try {
        if (settingsSecond !== undefined) settings = decodeSettings(JSON.parse(settingsSecond) as unknown);
      } catch { /* A corrupt complete file has safe effective defaults. */ }
      try {
        if (practiceSecond !== undefined) practice = decodePracticeSettings(JSON.parse(practiceSecond) as unknown);
      } catch { /* A corrupt complete file has safe effective defaults. */ }
      return { settings: copySettings(settings), practice: copyPracticeSettings(practice) };
    }
    throw new Error("Practice policy read deadline exceeded");
  }

  private updatePractice(
    mutator: (practice: PracticeSettings) => PracticeSettings,
  ): Promise<void> {
    return this.enqueueMutation(async (signal) => {
      await this.savePracticeUnsafe(mutator(copyPracticeSettings(this.practice)), signal);
    });
  }

  recordPracticeConsent(consentedAt: number): Promise<void> {
    return this.updatePractice((practice) => ({
      ...practice,
      revision: practice.revision + 1,
      consentedAt,
    }));
  }

  setPracticeEnabled(enabled: boolean): Promise<void> {
    return this.updatePractice((practice) => ({
      ...practice,
      revision: practice.revision + 1,
      enabled,
    }));
  }

  setPracticeTarget(target: PracticeTarget, selected: boolean): Promise<void> {
    let canonicalTarget: PracticeTarget;
    try {
      canonicalTarget = canonicalizePracticeTargets([target])[0]!;
    } catch (error) {
      return Promise.reject(error);
    }
    return this.updatePractice((practice) => {
      const remaining = practice.targets.filter((item) => item.explanation !== canonicalTarget.explanation);
      const targets = canonicalizePracticeTargets(selected ? [...remaining, canonicalTarget] : remaining);
      return { ...practice, revision: practice.revision + 1, targets };
    });
  }

  /** Revision/deadline-fenced modal action. False means no sidecar replacement occurred. */
  snoozePracticeForFiveHours(
    expectedRevision: number,
    operationDeadline: number,
    now = Date.now(),
  ): Promise<boolean> {
    if (!Number.isFinite(operationDeadline) || !Number.isFinite(now) || now < 0) {
      return Promise.reject(new Error("Invalid practice snooze"));
    }
    return this.enqueueMutation(async (signal) => {
      if (Date.now() >= operationDeadline || this.practice.revision !== expectedRevision) return false;
      return this.savePracticeUnsafe({
        ...this.practice,
        revision: this.practice.revision + 1,
        snoozedUntil: now + FIVE_HOURS_MS,
      }, signal, operationDeadline);
    });
  }

  resumePractice(): Promise<void> {
    return this.updatePractice((practice) => {
      const { snoozedUntil: _snoozedUntil, ...rest } = practice;
      return { ...rest, revision: practice.revision + 1 };
    });
  }

  resetPractice(): Promise<void> {
    return this.updatePractice((practice) => ({
      schemaVersion: PRACTICE_SCHEMA_VERSION,
      revision: practice.revision + 1,
      epoch: practice.epoch + 1,
      enabled: false,
      targets: [],
    }));
  }

  private async savePracticeUnsafe(
    practice: PracticeSettings,
    signal: AbortSignal,
    operationDeadline?: number,
  ): Promise<boolean> {
    const copied = decodePracticeSettings(practice);
    const temporary = `${this.practicePath}.${process.pid}.${randomUUID()}.tmp`;
    signal.throwIfAborted();
    await writeFile(temporary, `${JSON.stringify(copied, null, 2)}\n`, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
      signal,
    });
    signal.throwIfAborted();
    if (operationDeadline !== undefined && Date.now() >= operationDeadline) {
      await rm(temporary, { force: true });
      return false;
    }
    await FluencyStore.practiceFileReplacer(temporary, this.practicePath);
    signal.throwIfAborted();
    this.practice = copied;
    return true;
  }

  updateSettings(
    patchOrMutator: Partial<FluencySettings> | ((settings: FluencySettings) => Partial<FluencySettings>),
  ): Promise<void> {
    let mutator: ((settings: FluencySettings) => Partial<FluencySettings>) | undefined;
    let directPatch: Partial<FluencySettings> = {};
    if (typeof patchOrMutator === "function") mutator = patchOrMutator;
    else {
      try {
        directPatch = copySettingsPatch(patchOrMutator);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return this.enqueueMutation(async (signal) => {
      const patch = mutator
        ? copySettingsPatch(mutator(copySettings(this.settings)))
        : directPatch;
      await this.saveSettingsUnsafe({ ...this.settings, ...patch }, signal);
    });
  }

  private async saveSettingsUnsafe(settings: FluencySettings, signal: AbortSignal): Promise<void> {
    const copied = decodeSettings(settings);
    const temporary = `${this.settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    signal.throwIfAborted();
    await writeFile(temporary, `${JSON.stringify(copied, null, 2)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE, signal });
    signal.throwIfAborted();
    await FluencyStore.settingsFileReplacer(temporary, this.settingsPath);
    signal.throwIfAborted();
    this.settings = copied;
  }

  appendAnalysis(prompt: CollectedPrompt, result: AnalysisResult): Promise<void> {
    const copiedPrompt: CollectedPrompt = {
      promptHash: prompt.promptHash,
      prose: prompt.prose,
      observedAt: prompt.observedAt,
    };
    let event: FluencyEvent;
    try {
      if (result.schemaVersion !== 3) throw new Error("Invalid schema-v4 history event");
      const sanitizedResult = copyAnalysisResult(result);
      event = decodeHistoryLine({
        schemaVersion: HISTORY_SCHEMA_VERSION,
        type: "analysis",
        at: copiedPrompt.observedAt,
        prompt: copiedPrompt,
        wordCount: countEnglishWords(copiedPrompt.prose),
        result: sanitizedResult,
      });
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueueMutation((signal) => {
      this.assertHistoryReady();
      return this.appendUnsafe(event, signal);
    });
  }

  private reviewPatternBatch(
    patternId: string,
    decision: "accepted" | "dismissed",
    at = Date.now(),
  ): Promise<void> {
    return this.enqueueMutation(async (signal) => {
      signal.throwIfAborted();
      this.assertHistoryReady();
      const pattern = this.state.patterns.get(patternId);
      if (!pattern) throw new Error(`Unknown pattern: ${patternId}`);
      const occurrenceIds = [...this.state.occurrences.values()]
        .filter((occurrence) => occurrence.patternId === patternId && occurrence.decision === "pending")
        .map((occurrence) => occurrence.id);
      if (occurrenceIds.length === 0) return;
      await this.appendUnsafe({
        schemaVersion: HISTORY_SCHEMA_VERSION,
        type: "review",
        at,
        occurrenceIds,
        decision,
      }, signal);
    });
  }

  acceptPattern(patternId: string, at = Date.now()): Promise<void> {
    return this.reviewPatternBatch(patternId, "accepted", at);
  }

  dismissPattern(patternId: string, at = Date.now()): Promise<void> {
    return this.reviewPatternBatch(patternId, "dismissed", at);
  }

  clear(): Promise<void> {
    return this.enqueueMutation((signal) => this.clearUnsafe(signal));
  }

  private async clearUnsafe(signal: AbortSignal): Promise<void> {
    const generation = randomUUID();
    signal.throwIfAborted();
    await this.writeHistoryGenerationUnsafe(generation, true, signal);
    this.historyGeneration = generation;
    this.pendingEvents.length = 0;
    await this.replaceHistoryWithEmptyUnsafe(signal);
    await this.writeHistoryGenerationUnsafe(generation, false, signal);
    this.state.patterns.clear();
    this.state.observations.clear();
    this.state.occurrences.clear();
    this.state.processedPromptHashes.clear();
    this.eventsSinceCompact = 0;
    this.historyResetRequired = false;
    for (let index = this.warnings.indexOf(HISTORY_SCHEMA_WARNING); index >= 0; index = this.warnings.indexOf(HISTORY_SCHEMA_WARNING)) {
      this.warnings.splice(index, 1);
    }
  }

  private assertHistoryReady(): void {
    if (this.historyResetRequired) throw new HistorySchemaMismatchError();
  }

  compact(at = Date.now()): Promise<void> {
    return this.enqueueMutation((signal) => this.compactUnsafe(signal, at));
  }

  private async compactUnsafe(signal: AbortSignal, at = Date.now()): Promise<void> {
    this.assertHistoryReady();
    signal.throwIfAborted();
    const event = buildRetainedSnapshot(this.state, {
      now: at,
      retentionLimit: this.settings.retentionLimit,
    });
    const temporary = `${this.historyPath}.${process.pid}.${randomUUID()}.tmp`;
    signal.throwIfAborted();
    await writeFile(temporary, `${encodeHistoryEvent(event)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE, signal });
    signal.throwIfAborted();
    await FluencyStore.historyFileReplacer(temporary, this.historyPath);
    signal.throwIfAborted();
    reduceHistoryEvent(this.state, event);
    this.pendingEvents.length = 0;
    this.eventsSinceCompact = 0;
  }

  private async appendUnsafe(event: FluencyEvent, signal: AbortSignal): Promise<void> {
    const serialized = [...this.pendingEvents.map((pending) => pending.event), event]
      .map(encodeHistoryEvent)
      .join("\n") + "\n";
    try {
      signal.throwIfAborted();
      await appendFile(this.historyPath, serialized, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
      signal.throwIfAborted();
      this.pendingEvents.length = 0;
    } catch (error) {
      signal.throwIfAborted();
      this.pendingEvents.push({ generation: this.historyGeneration, event });
      reduceHistoryEvent(this.state, event);
      this.warnings.push("History write failed; event retained in memory");
      throw error;
    }
    signal.throwIfAborted();
    reduceHistoryEvent(this.state, event);
    this.eventsSinceCompact += 1;
    if (this.eventsSinceCompact >= 100 || this.state.patterns.size > this.settings.retentionLimit) {
      await this.compactUnsafe(signal);
    }
  }
}
