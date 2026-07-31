import { access, chmod, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock, type LockOptions } from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluencyStore } from "../extensions/pi-fluency/store.js";
import { DEFAULT_SETTINGS, type AnalysisResult, type FluencySettings } from "../extensions/pi-fluency/types.js";
import {
  analysisResult as result,
  collected,
  createStoreRoot,
  historyAnalysis,
  observation,
  occurrences,
  patterns,
  replaceFirstSnapshotField,
  resultFor,
  type SnapshotMutator,
} from "./helpers/store-fixtures.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await createStoreRoot());
});

afterEach(async () => {
  await cleanup();
});

describe("FluencyStore concurrency", () => {
  it("serializes concurrent appends, compaction, and settings writes", async () => {
    const store = await FluencyStore.open(root);
    const appends = Array.from({ length: 40 }, (_, index) =>
      store.appendAnalysis(collected(`concurrent-${index}`, index), result));
    const compaction = store.compact();
    const settingsWrites = Array.from({ length: 20 }, (_, index) =>
      store.updateSettings({ modelId: `model-${index}` }));

    await Promise.all([...appends, compaction, ...settingsWrites]);
    const reopened = await FluencyStore.open(root);
    expect(reopened.listInbox()[0]?.occurrenceCount).toBe(40);
    expect(reopened.getSettings().modelId).toBe("model-19");
    expect(reopened.getAnalyticsSnapshot().observations).toHaveLength(40);
  });

  it("resolves cross-process Accept versus Dismiss as one complete batch decision", async () => {
    const seed = await FluencyStore.open(root);
    await seed.appendAnalysis(collected("race-one", 100), resultFor("review.race"));
    await seed.appendAnalysis(collected("race-two", 110), resultFor("review.race"));
    const pattern = seed.listInbox()[0]!;
    const acceptor = await FluencyStore.open(root);
    const dismisser = await FluencyStore.open(root);

    await Promise.all([
      acceptor.acceptPattern(pattern.id, 120),
      dismisser.dismissPattern(pattern.id, 120),
    ]);

    const decisions = occurrences(await FluencyStore.open(root))
      .filter((occurrence) => occurrence.patternId === pattern.id)
      .map((occurrence) => occurrence.decision);
    expect(new Set(decisions).size).toBe(1);
    expect(["accepted", "dismissed"]).toContain(decisions[0]);
    expect(decisions).toHaveLength(2);
    expect(decisions).not.toContain("pending");
  });

  it("serializes appends and compaction across store instances", async () => {
    const left = await FluencyStore.open(root);
    const right = await FluencyStore.open(root);
    const leftAppends = Array.from({ length: 20 }, (_, index) =>
      left.appendAnalysis(collected(`left-${index}`, index), result));
    const rightAppends = Array.from({ length: 20 }, (_, index) =>
      right.appendAnalysis(collected(`right-${index}`, index + 100), result));

    await Promise.all([...leftAppends, right.compact(), ...rightAppends, left.compact()]);
    const reopened = await FluencyStore.open(root);
    expect(reopened.listInbox()[0]?.occurrenceCount).toBe(40);
    expect(reopened.getAnalyticsSnapshot().observations).toHaveLength(40);
  });

  it("coordinates two contenders while recovering a stale filesystem lock", async () => {
    const left = await FluencyStore.open(root);
    const right = await FluencyStore.open(root);
    const lockPath = `${root}.lock`;
    await mkdir(lockPath);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await Promise.all([
      left.appendAnalysis(collected("after-stale-left", 100), result),
      right.appendAnalysis(collected("after-stale-right", 200), result),
    ]);
    const reopened = await FluencyStore.open(root);
    expect(reopened.listInbox()[0]?.occurrenceCount).toBe(2);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits beyond the former retry window for a healthy lock owner", async () => {
    const store = await FluencyStore.open(root);
    const release = await lock(root, { realpath: false, stale: 30_000, update: 10_000 });
    const startedAt = Date.now();
    const append = store.appendAnalysis(collected("waited-for-lock", 100), result);
    await delay(4_250);
    await release();
    await append;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_000);
    expect(store.listInbox()).toHaveLength(1);
  }, 10_000);

  it("aborts compromised mutations, preserves primary error, and resumes healthy work", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("baseline", 100), result);
    await store.updateSettings({ modelId: "baseline-model" });
    const historyPath = join(root, "history.jsonl");
    const settingsPath = join(root, "settings.json");
    const initialHistory = await readFile(historyPath, "utf8");
    const initialSettings = await readFile(settingsPath, "utf8");

    type LockProvider = (file: string, options: LockOptions) => Promise<() => Promise<void>>;
    const storeClass = FluencyStore as unknown as { lockProvider: LockProvider };
    const originalProvider = storeClass.lockProvider;
    storeClass.lockProvider = async (_file, options) => {
      setImmediate(() => {
        const error = Object.assign(new Error("Injected lock compromise"), { code: "ECOMPROMISED" });
        options.onCompromised?.(error);
      });
      return async () => {
        throw Object.assign(new Error("Injected released lock"), { code: "ERELEASED" });
      };
    };

    try {
      await expect(store.appendAnalysis(collected("must-abort", 200), result)).rejects.toMatchObject({
        code: "ECOMPROMISED",
        message: "Injected lock compromise",
      });
      await expect(store.updateSettings({ modelId: "must-abort" })).rejects.toMatchObject({
        code: "ECOMPROMISED",
        message: "Injected lock compromise",
      });
      await delay(25);
      expect(await readFile(historyPath, "utf8")).toBe(initialHistory);
      expect(await readFile(settingsPath, "utf8")).toBe(initialSettings);
      expect(store.listInbox()[0]?.occurrenceCount).toBe(1);
      expect(store.getSettings().modelId).toBe("baseline-model");
    } finally {
      storeClass.lockProvider = originalProvider;
    }

    await store.appendAnalysis(collected("healthy-after-compromise", 300), result);
    expect(store.listInbox()[0]?.occurrenceCount).toBe(2);
  });

  it("merges concurrent practice target mutations without settings-v3 interference", async () => {
    const left = await FluencyStore.open(root);
    const right = await FluencyStore.open(root);
    await Promise.all([
      left.setPracticeTarget({ explanation: "Article rule", memberPatternKeys: ["det.article"] }, true),
      right.setPracticeTarget({ explanation: "Agreement rule", memberPatternKeys: ["verb.agreement"] }, true),
    ]);

    const practiceBeforeOldWriter = (await FluencyStore.open(root)).getPracticeSettings();
    await writeFile(join(root, "settings.json"), JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      modelId: "old-extension-write",
    }));
    const reopened = await FluencyStore.open(root);
    expect(reopened.getPracticeSettings()).toEqual(practiceBeforeOldWriter);
    expect(reopened.getPracticeSettings().targets.map((target) => target.explanation)).toEqual([
      "Agreement rule",
      "Article rule",
    ]);
  });

  it("retries an optimistic policy read when settings changes between sidecar reads", async () => {
    const store = await FluencyStore.open(root);
    const other = await FluencyStore.open(root);
    await other.setPracticeTarget({ explanation: "Fresh rule", memberPatternKeys: ["fresh.rule"] }, true);

    type PolicyFileReader = (path: string) => Promise<string>;
    const storeClass = FluencyStore as unknown as { policyFileReader: PolicyFileReader };
    const originalReader = storeClass.policyFileReader;
    let replaced = false;
    storeClass.policyFileReader = async (path) => {
      if (!replaced && path.endsWith("practice.json")) {
        replaced = true;
        await writeFile(join(root, "settings.json"), JSON.stringify({
          ...DEFAULT_SETTINGS,
          enabled: true,
          provider: "fresh-provider",
          modelId: "fresh-model",
          ignoredPatternKeys: ["fresh.ignore"],
        }));
      }
      return readFile(path, "utf8");
    };

    try {
      const snapshot = await store.getFreshPolicySnapshot(Date.now() + 1_000);
      expect(snapshot.settings).toMatchObject({
        enabled: true,
        provider: "fresh-provider",
        modelId: "fresh-model",
        ignoredPatternKeys: ["fresh.ignore"],
      });
      expect(snapshot.practice.targets).toEqual([
        { explanation: "Fresh rule", memberPatternKeys: ["fresh.rule"] },
      ]);
      expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
      expect(store.getPracticeSettings().targets).toEqual([]);
    } finally {
      storeClass.policyFileReader = originalReader;
    }
  });

  it("bounds a hung policy file read by the supplied deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = await FluencyStore.open(root);
    type PolicyFileReader = (path: string) => Promise<string>;
    const storeClass = FluencyStore as unknown as { policyFileReader: PolicyFileReader };
    const originalReader = storeClass.policyFileReader;
    storeClass.policyFileReader = () => new Promise<string>(() => undefined);
    try {
      const assertion = expect(store.getFreshPolicySnapshot(Date.now() + 50))
        .rejects.toThrow("Practice policy read deadline exceeded");
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      storeClass.policyFileReader = originalReader;
      vi.useRealTimers();
    }
  });

  it("rejects a policy snapshot when the final missing-file read crosses its deadline", async () => {
    const store = await FluencyStore.open(root);
    type PolicyFileReader = (path: string) => Promise<string>;
    const storeClass = FluencyStore as unknown as { policyFileReader: PolicyFileReader };
    const originalReader = storeClass.policyFileReader;
    const settings = JSON.stringify(DEFAULT_SETTINGS);
    let now = 10;
    let reads = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    storeClass.policyFileReader = async (path) => {
      reads += 1;
      if (path.endsWith("practice.json")) {
        if (reads === 5) now = 20;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (path.endsWith("history-generation")) return originalReader(path);
      return settings;
    };

    try {
      await expect(store.getFreshPolicySnapshot(20)).rejects.toThrow("Practice policy read deadline exceeded");
      expect(reads).toBe(5);
    } finally {
      storeClass.policyFileReader = originalReader;
      nowSpy.mockRestore();
    }
  });

  it("does not activate a snooze when lock acquisition finishes after its deadline", async () => {
    const store = await FluencyStore.open(root);
    const practicePath = join(root, "practice.json");
    await store.setPracticeEnabled(true);
    const before = await readFile(practicePath, "utf8");

    type LockProvider = (file: string, options: LockOptions) => Promise<() => Promise<void>>;
    const storeClass = FluencyStore as unknown as { lockProvider: LockProvider };
    const originalProvider = storeClass.lockProvider;
    storeClass.lockProvider = async () => {
      await delay(30);
      return async () => undefined;
    };
    try {
      await expect(store.snoozePracticeForFiveHours(1, Date.now() + 5)).resolves.toBe(false);
      expect(await readFile(practicePath, "utf8")).toBe(before);
      expect(store.getPracticeSettings()).not.toHaveProperty("snoozedUntil");
    } finally {
      storeClass.lockProvider = originalProvider;
    }
  });

  it("releases filesystem lock after a thrown mutation", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("before-read-error", 100), result);
    const historyPath = join(root, "history.jsonl");
    await rm(historyPath);
    await mkdir(historyPath);

    await expect(store.appendAnalysis(collected("must-not-apply", 200), result)).rejects.toThrow();
    expect(store.listInbox()[0]?.occurrenceCount).toBe(1);
    await expect(access(historyPath)).resolves.toBeUndefined();
    await expect(access(`${root}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
