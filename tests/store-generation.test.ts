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

describe("FluencyStore generation recovery", () => {
  it("opens and canonicalizes a plain generation marker written by the initial clear protocol", async () => {
    const generation = "9a6d03ea-1a39-4760-8271-f7f5ab9ceae6\n";
    const generationPath = join(root, "history-generation");
    await writeFile(generationPath, generation, { mode: 0o600 });

    const store = await FluencyStore.open(root);

    expect(store.requiresHistoryReset()).toBe(false);
    expect(JSON.parse(await readFile(generationPath, "utf8"))).toEqual({
      generation: generation.trim(),
      resetPending: false,
    });
    await store.appendAnalysis(collected("plain-generation"), result);
    expect((await FluencyStore.open(root)).hasProcessedPromptHash("plain-generation")).toBe(true);
  });

  it("requires clear for pre-v4 history without rewriting it", async () => {
    const original = `${JSON.stringify({ type: "snapshot", schemaVersion: 3, patterns: [] })}\n`;
    const historyPath = join(root, "history.jsonl");
    await writeFile(historyPath, original);

    const store = await FluencyStore.open(root);
    expect(store.requiresHistoryReset()).toBe(true);
    expect(store.getWarnings()).toContain("History migration required; run /fluency clear");
    await expect(store.appendAnalysis(collected("blocked"), result)).rejects.toThrow("Unsupported fluency history schema");
    expect(await readFile(historyPath, "utf8")).toBe(original);
    await store.clear();
    expect(store.requiresHistoryReset()).toBe(false);
    expect(await readFile(historyPath, "utf8")).toBe("");
  });

  it("flushes retained events after a transient history write failure", async () => {
    const store = await FluencyStore.open(root);
    const historyPath = join(root, "history.jsonl");
    await chmod(historyPath, 0o444);

    await expect(store.appendAnalysis(collected("hash-1", 100), result)).rejects.toThrow();
    expect(store.listInbox()).toHaveLength(1);
    expect(store.getWarnings()).toContain("History write failed; event retained in memory");

    await chmod(historyPath, 0o644);
    await store.appendAnalysis(collected("hash-2", 200), result);
    expect((await FluencyStore.open(root)).listInbox()[0]?.occurrenceCount).toBe(2);
  });

  it("clear discards events retained after a write failure", async () => {
    const store = await FluencyStore.open(root);
    const historyPath = join(root, "history.jsonl");
    await chmod(historyPath, 0o444);
    await expect(store.appendAnalysis(collected("hash-1", 100), result)).rejects.toThrow();

    await chmod(historyPath, 0o644);
    await store.clear();
    await store.appendAnalysis(collected("hash-2", 200), result);
    expect((await FluencyStore.open(root)).listInbox()[0]?.occurrenceCount).toBe(1);
  });

  it("does not resurrect another instance's retained event after clear", async () => {
    const stale = await FluencyStore.open(root);
    const historyPath = join(root, "history.jsonl");
    await chmod(historyPath, 0o444);
    await expect(stale.appendAnalysis(collected("before-clear", 100), result)).rejects.toThrow();
    await chmod(historyPath, 0o600);

    const clearer = await FluencyStore.open(root);
    await clearer.clear();
    await stale.appendAnalysis(collected("after-clear", 200), result);

    const reopened = await FluencyStore.open(root);
    expect(reopened.hasProcessedPromptHash("before-clear")).toBe(false);
    expect(reopened.hasProcessedPromptHash("after-clear")).toBe(true);
    expect(reopened.listInbox()[0]?.occurrenceCount).toBe(1);
  });

  it("discards delayed precomputed analysis after clear generation changes", async () => {
    const store = await FluencyStore.open(root);
    await store.updateSettings({
      ...DEFAULT_SETTINGS,
      enabled: true,
      consentedAt: 1,
      provider: "provider",
      modelId: "model",
    });
    const fence = store.captureAnalysisCommitFence();
    await (await FluencyStore.open(root)).clear();

    expect(await store.conditionalAppendAnalysis(fence, collected("stale-after-clear"), result))
      .toBe("generation-stale");
    expect((await FluencyStore.open(root)).hasProcessedPromptHash("stale-after-clear")).toBe(false);
  });

  it("distinguishes revoked analytics authorization from analyzer changes", async () => {
    const store = await FluencyStore.open(root);
    await store.updateSettings({
      ...DEFAULT_SETTINGS,
      enabled: true,
      consentedAt: 1,
      provider: "provider",
      modelId: "model",
    });
    const fence = store.captureAnalysisCommitFence();
    await (await FluencyStore.open(root)).updateSettings({ enabled: false });

    expect(await store.conditionalAppendAnalysis(fence, collected("stale-auth"), result))
      .toBe("authorization-stale");
    expect((await FluencyStore.open(root)).hasProcessedPromptHash("stale-auth")).toBe(false);

    await (await FluencyStore.open(root)).updateSettings({ enabled: true, modelId: "new-model" });
    expect(await store.conditionalAppendAnalysis(fence, collected("stale-analyzer"), result))
      .toBe("analyzer-stale");
    expect((await FluencyStore.open(root)).hasProcessedPromptHash("stale-analyzer")).toBe(false);
  });

  it("conditionally appends once when generation and analyzer authorization stay exact", async () => {
    const store = await FluencyStore.open(root);
    await store.updateSettings({
      ...DEFAULT_SETTINGS,
      enabled: true,
      consentedAt: 1,
      provider: "provider",
      modelId: "model",
    });
    const fence = store.captureAnalysisCommitFence();

    expect(await store.conditionalAppendAnalysis(fence, collected("fresh-config"), result)).toBe("committed");
    expect((await FluencyStore.open(root)).hasProcessedPromptHash("fresh-config")).toBe(true);
  });

  it("finishes an interrupted clear before replaying durable history", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("must-stay-cleared", 100), result);
    type FileReplacer = (temporary: string, destination: string) => Promise<void>;
    const storeClass = FluencyStore as unknown as { historyFileReplacer: FileReplacer };
    const originalReplacer = storeClass.historyFileReplacer;
    let failOnce = true;
    storeClass.historyFileReplacer = async (temporary, destination) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("Injected history replacement failure");
      }
      await rename(temporary, destination);
    };

    try {
      await expect(store.clear()).rejects.toThrow("Injected history replacement failure");
    } finally {
      storeClass.historyFileReplacer = originalReplacer;
    }

    const reopened = await FluencyStore.open(root);
    expect(reopened.hasProcessedPromptHash("must-stay-cleared")).toBe(false);
    expect(reopened.listReviewPatterns()).toEqual([]);
    expect(await readFile(join(root, "history.jsonl"), "utf8")).toBe("");
    const marker = JSON.parse(await readFile(join(root, "history-generation"), "utf8"));
    expect(marker.resetPending).toBe(false);
    await reopened.appendAnalysis(collected("after-recovery", 200), result);
    const reopenedAgain = await FluencyStore.open(root);
    expect(reopenedAgain.hasProcessedPromptHash("after-recovery")).toBe(true);
  });

  it.each([
    "not-json",
    JSON.stringify({ generation: "not-a-uuid", resetPending: true }),
    JSON.stringify({ generation: "9a6d03ea-1a39-4760-8271-f7f5ab9ceae6" }),
  ])("rejects malformed generation marker without touching history: %s", async (marker) => {
    const historyPath = join(root, "history.jsonl");
    const generationPath = join(root, "history-generation");
    const original = `${JSON.stringify(historyAnalysis("must-survive"))}\n`;
    await writeFile(historyPath, original);
    await writeFile(generationPath, marker);

    await expect(FluencyStore.open(root)).rejects.toThrow("Invalid history generation");
    expect(await readFile(historyPath, "utf8")).toBe(original);
  });
});
