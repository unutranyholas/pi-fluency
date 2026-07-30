import { access, chmod, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock, type LockOptions } from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
