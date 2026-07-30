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

describe("FluencyStore settings", () => {
  it("enforces private modes for existing and replaced history files under permissive umask", async () => {
    const originalUmask = process.umask(0);
    try {
      await chmod(root, 0o777);
      await writeFile(join(root, "history.jsonl"), "", { mode: 0o666 });
      await writeFile(join(root, "settings.json"), JSON.stringify(DEFAULT_SETTINGS), { mode: 0o666 });
      await chmod(join(root, "history.jsonl"), 0o666);
      await chmod(join(root, "settings.json"), 0o666);

      const store = await FluencyStore.open(root);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "history.jsonl"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "settings.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "history-generation"))).mode & 0o777).toBe(0o600);

      await store.updateSettings({ enabled: true });
      await store.appendAnalysis(collected("private-modes", Date.now()), result);
      await store.compact();
      expect((await stat(join(root, "history.jsonl"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "settings.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "history-generation"))).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(originalUmask);
    }
  });

  it("round-trips settings atomically", async () => {
    const store = await FluencyStore.open(root);
    await store.updateSettings({
      enabled: true,
      consentedAt: 123,
      provider: "google",
      modelId: "gemini-2.5-flash",
    });
    const reopened = await FluencyStore.open(root);
    expect(reopened.getSettings()).toMatchObject({
      enabled: true,
      provider: "google",
      modelId: "gemini-2.5-flash",
    });
  });

  it.each([1, 2])("does not migrate pre-v3 settings schema %s", async (schemaVersion) => {
    const original = JSON.stringify({
      schemaVersion,
      enabled: true,
      minimumConfidence: 0.8,
      retentionLimit: 500,
      ignoredPatternKeys: ["old.pattern"],
      ignoredClassIds: ["grammar.articles"],
    });
    const settingsPath = join(root, "settings.json");
    await writeFile(settingsPath, original);

    const store = await FluencyStore.open(root);
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(store.getWarnings()).toContain("Could not read settings; defaults loaded");
    expect(await readFile(settingsPath, "utf8")).toBe(original);
  });

  it("does not expose settings array aliases", async () => {
    const store = await FluencyStore.open(root);
    const returned = store.getSettings();
    returned.ignoredPatternKeys.push("external.get");
    returned.ignoredCategories.push("DET");
    expect(store.getSettings().ignoredPatternKeys).toEqual([]);
    expect(store.getSettings().ignoredCategories).toEqual([]);

    const saved: FluencySettings = {
      ...store.getSettings(),
      ignoredPatternKeys: ["saved.pattern"],
      ignoredCategories: ["PREP"],
    };
    await store.updateSettings(saved);
    saved.ignoredPatternKeys.push("external.save");
    saved.ignoredCategories.push("DET");
    expect(store.getSettings().ignoredPatternKeys).toEqual(["saved.pattern"]);
    expect(store.getSettings().ignoredCategories).toEqual(["PREP"]);
  });

  it("restores exact-pattern and category ignores in one atomic replacement", async () => {
    const store = await FluencyStore.open(root);
    await store.updateSettings({
      ignoredPatternKeys: ["keep.pattern", "restore.pattern"],
      ignoredCategories: ["DET", "PREP"],
    });
    const settingsPath = join(root, "settings.json");
    const before = await readFile(settingsPath, "utf8");

    type SettingsFileReplacer = (temporary: string, destination: string) => Promise<void>;
    const storeClass = FluencyStore as unknown as { settingsFileReplacer: SettingsFileReplacer };
    const originalReplacer = storeClass.settingsFileReplacer;
    storeClass.settingsFileReplacer = async () => { throw new Error("Injected settings replacement failure"); };
    try {
      await expect(store.restoreIgnoreTargets({
        patternKeys: ["restore.pattern", "restore.pattern"],
        categories: ["DET", "DET"],
      })).rejects.toThrow("Injected settings replacement failure");
      expect(store.getSettings()).toMatchObject({
        ignoredPatternKeys: ["keep.pattern", "restore.pattern"],
        ignoredCategories: ["DET", "PREP"],
      });
      expect(await readFile(settingsPath, "utf8")).toBe(before);
      expect((await FluencyStore.open(root)).getSettings()).toMatchObject({
        ignoredPatternKeys: ["keep.pattern", "restore.pattern"],
        ignoredCategories: ["DET", "PREP"],
      });
    } finally {
      storeClass.settingsFileReplacer = originalReplacer;
    }

    await store.restoreIgnoreTargets({
      patternKeys: ["restore.pattern"],
      categories: ["DET"],
    });
    expect(store.getSettings()).toMatchObject({
      ignoredPatternKeys: ["keep.pattern"],
      ignoredCategories: ["PREP"],
    });
  });

  it("hides ignored categories while retaining tracked patterns", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("hash-1", 100), result);
    await store.ignoreCategory("DET");
    expect(store.listInbox()).toEqual([]);
    expect(store.listIgnored()).toHaveLength(1);
    expect(patterns(store)).toHaveLength(1);
    await store.restoreIgnoreTargets({ patternKeys: [], categories: ["DET"] });
    expect(store.listInbox()).toHaveLength(1);
  });

  it("applies one ignored category to missing, unnecessary, and replacement variants", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("missing", 100), resultFor("punct.missing", "M:PUNCT"));
    await store.appendAnalysis(collected("unnecessary", 110), resultFor("punct.unnecessary", "U:PUNCT"));
    await store.appendAnalysis(collected("replacement", 120), resultFor("punct.replacement", "R:PUNCT"));
    expect(store.listInbox()).toHaveLength(3);
    await store.ignoreCategory("PUNCT");
    expect(store.listInbox()).toEqual([]);
    expect(store.listIgnored()).toHaveLength(3);
    await store.restoreIgnoreTargets({ patternKeys: [], categories: ["PUNCT"] });
    expect(store.listInbox()).toHaveLength(3);
  });

  it("copies direct settings patch arrays before queued persistence", async () => {
    const store = await FluencyStore.open(root);
    const ignoredPatternKeys = ["rule.before-queue"];
    const saving = store.updateSettings({ ignoredPatternKeys });
    ignoredPatternKeys.push("rule.after-call");
    await saving;

    expect(store.getSettings().ignoredPatternKeys).toEqual(["rule.before-queue"]);
    expect((await FluencyStore.open(root)).getSettings().ignoredPatternKeys).toEqual(["rule.before-queue"]);
  });

  it("merges concurrent settings operations across store instances", async () => {
    const left = await FluencyStore.open(root);
    const right = await FluencyStore.open(root);
    const keys = Array.from({ length: 20 }, (_, index) => `pattern-${index}`);
    await Promise.all(keys.map((key, index) =>
      (index % 2 === 0 ? left : right).ignorePatternKey(key)));

    const settingsFile = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as FluencySettings;
    expect(settingsFile.ignoredPatternKeys.toSorted()).toEqual(keys.toSorted());
    expect((await FluencyStore.open(root)).getSettings().ignoredPatternKeys.toSorted()).toEqual(keys.toSorted());
  });

  it("preserves concurrent ignore arrays across stale pause, resume, and model saves", async () => {
    const left = await FluencyStore.open(root);
    const right = await FluencyStore.open(root);
    await Promise.all([
      left.ignorePatternKey("grammar.concurrent-ignore"),
      right.updateSettings({
        enabled: true,
        consentedAt: 999,
        provider: "new-provider",
        modelId: "new-model",
      }),
    ]);
    await Promise.all([
      left.ignoreCategory("PREP"),
      right.updateSettings({ enabled: false }),
    ]);

    const settings = (await FluencyStore.open(root)).getSettings();
    expect(settings).toMatchObject({
      enabled: false,
      consentedAt: 999,
      provider: "new-provider",
      modelId: "new-model",
      ignoredPatternKeys: ["grammar.concurrent-ignore"],
      ignoredCategories: ["PREP"],
    });
  });

  it.each([
    ["NaN confidence", { minimumConfidence: Number.NaN }],
    ["confidence above one", { minimumConfidence: 1.1 }],
    ["negative retention", { retentionLimit: -1 }],
  ])("rejects invalid settings before persistence: %s", async (_name, patch) => {
    const store = await FluencyStore.open(root);
    const before = await readFile(join(root, "settings.json"), "utf8").catch(() => undefined);
    await expect(store.updateSettings(patch)).rejects.toThrow("Invalid settings");
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await readFile(join(root, "settings.json"), "utf8").catch(() => undefined)).toBe(before);
  });

  it.each([
    ["string pattern keys", { ignoredPatternKeys: "abc" }],
    ["null categories", { ignoredCategories: null }],
  ])("rejects malformed settings collection patches: %s", async (_name, value) => {
    const store = await FluencyStore.open(root);
    const patch = value as unknown as Partial<FluencySettings>;
    await expect(store.updateSettings(patch)).rejects.toThrow("Invalid settings");
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect((await FluencyStore.open(root)).getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
