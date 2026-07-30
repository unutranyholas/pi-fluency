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

describe("FluencyStore retention integration", () => {
  it("compacts state without resurrecting dismissed records", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("hash-1", 100), result);
    const [pattern] = store.listInbox();
    await store.dismissPattern(pattern!.id, 200);
    await store.compact();
    const file = await readFile(join(root, "history.jsonl"), "utf8");
    expect(file).not.toContain("dismissed");
    expect(file).toContain('"schemaVersion":4');
    expect((await FluencyStore.open(root)).listInbox()).toEqual([]);
  });

  it("retains every pending pattern during automatic compaction", async () => {
    const store = await FluencyStore.open(root);
    await store.updateSettings({ retentionLimit: 1 });
    await store.appendAnalysis(collected("hash-1", 100), {
      ...result,
      mistakes: [
        ...result.mistakes,
        { ...result.mistakes[0]!, patternKey: "grammar.articles.other" },
      ],
    });
    expect(patterns(store)).toHaveLength(2);
    expect(patterns(await FluencyStore.open(root))).toHaveLength(2);
  });

  it("does not resurrect an expired reviewed rule during compaction", async () => {
    const store = await FluencyStore.open(root);
    const old = Date.now() - 366 * 24 * 60 * 60 * 1_000;
    await store.appendAnalysis(collected("expired-review", old), resultFor("review.expired"));
    await store.acceptPattern(store.listInbox()[0]!.id, old + 1);
    await store.compact();

    const reopened = await FluencyStore.open(root);
    expect(reopened.listInbox()).toEqual([]);
    expect(reopened.listAccepted()).toEqual([]);
    expect(patterns(reopened)).toEqual([]);
  });

  it("retains reviewed data by persisted local calendar date instead of elapsed timestamp", async () => {
    const store = await FluencyStore.open(root);
    const now = new Date(2026, 6, 20, 12).getTime();
    await store.appendAnalysis(collected("calendar-retained", now), resultFor("calendar.rule"));
    await store.acceptPattern(store.listInbox()[0]!.id, now);
    await store.appendAnalysis(collected("calendar-expired", now), resultFor("calendar.expired"));
    await store.acceptPattern(store.listInbox().find((item) => item.patternKey === "calendar.expired")!.id, now);

    const state = store.getAnalyticsSnapshot();
    const retainedOccurrence = state.occurrences.find((item) => item.promptHash === "calendar-retained")!;
    const retainedObservation = state.observations.find((item) => item.promptHash === "calendar-retained")!;
    retainedOccurrence.observedAt = 0;
    retainedOccurrence.localDate = "2025-07-21";
    retainedObservation.observedAt = 0;
    retainedObservation.localDate = "2025-07-21";
    const expiredOccurrence = state.occurrences.find((item) => item.promptHash === "calendar-expired")!;
    const expiredObservation = state.observations.find((item) => item.promptHash === "calendar-expired")!;
    expiredOccurrence.observedAt = now;
    expiredOccurrence.localDate = "2025-07-20";
    expiredObservation.observedAt = now;
    expiredObservation.localDate = "2025-07-20";
    await writeFile(join(root, "history.jsonl"), `${JSON.stringify({
      type: "snapshot",
      schemaVersion: 4,
      at: now,
      patterns: state.patterns,
      observations: state.observations,
      occurrences: state.occurrences,
      processedPromptHashes: ["calendar-retained", "calendar-expired"],
    })}\n`);

    const seeded = await FluencyStore.open(root);
    await seeded.compact(now);
    const reopened = await FluencyStore.open(root);
    expect(occurrences(reopened).some((item) => item.id === retainedOccurrence.id)).toBe(true);
    expect(observation(reopened, "calendar-retained")).toBeDefined();
    expect(occurrences(reopened).some((item) => item.id === expiredOccurrence.id)).toBe(false);
    expect(observation(reopened, "calendar-expired")).toBeUndefined();
  });

  it("preserves hashes referenced by retained observations so replay cannot overwrite decisions", async () => {
    const store = await FluencyStore.open(root);
    const now = Date.now();
    await store.updateSettings({ retentionLimit: 1 });
    await store.appendAnalysis(collected("reviewed-content-hash", now), resultFor("hash.reviewed"));
    const pattern = store.listInbox()[0]!;
    await store.acceptPattern(pattern.id, now);
    for (let index = 0; index < 12; index += 1) {
      await store.appendAnalysis(collected(`newer-hash-${index}`, now + index + 1), {
        schemaVersion: 3,
        language: "en",
        mistakes: [],
        demonstratedFixes: [],
      });
    }
    await store.compact(now + 20);

    const reopened = await FluencyStore.open(root);
    expect(reopened.hasProcessedPromptHash("reviewed-content-hash")).toBe(true);
    await reopened.appendAnalysis(collected("reviewed-content-hash", now + 30), resultFor("hash.reviewed"));
    expect(reopened.listAccepted()[0]).toMatchObject({ id: pattern.id, acceptedCount: 1, pendingCount: 0 });
    expect(reopened.listInbox()).toEqual([]);
  });

  it("bounds unreferenced hashes while preserving retained observation hashes and recent order", async () => {
    const store = await FluencyStore.open(root);
    await store.updateSettings({ retentionLimit: 1 });
    for (let index = 0; index < 15; index += 1) {
      await store.appendAnalysis(collected(`hash-${index}`, index), result);
    }
    for (let index = 0; index < 15; index += 1) {
      await store.appendAnalysis(collected(`other-${index}`, index + 20), {
        schemaVersion: 3,
        language: "other",
        mistakes: [],
        demonstratedFixes: [],
      });
    }
    await store.compact();

    const persisted = JSON.parse((await readFile(join(root, "history.jsonl"), "utf8")).trim());
    expect(persisted.processedPromptHashes).toEqual([
      ...Array.from({ length: 15 }, (_, index) => `hash-${index}`),
      ...Array.from({ length: 10 }, (_, index) => `other-${index + 5}`),
    ]);
  });
});
