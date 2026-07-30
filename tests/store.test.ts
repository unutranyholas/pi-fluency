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

describe("FluencyStore", () => {
  it("returns immutable analytics projections and focused processed-hash queries", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("immutable"), result);
    const snapshot = store.getAnalyticsSnapshot();
    snapshot.observations[0]!.wordCount = 999;
    snapshot.occurrences[0]!.decision = "accepted";
    snapshot.patterns[0]!.explanation = "mutated";
    snapshot.ignoredPatternKeys.push("mutated");

    const fresh = store.getAnalyticsSnapshot();
    expect(fresh.observations[0]?.wordCount).not.toBe(999);
    expect(fresh.occurrences[0]?.decision).toBe("pending");
    expect(fresh.patterns[0]?.explanation).not.toBe("mutated");
    expect(fresh.ignoredPatternKeys).not.toContain("mutated");
    expect(store.hasProcessedPromptHash("immutable")).toBe(true);
    expect(store.hasProcessedPromptHash("missing")).toBe(false);
  });

  it.each([
    ["invalid language", { schemaVersion: 3, language: "invalid", mistakes: [], demonstratedFixes: [] }],
    ["non-string correction", {
      ...result,
      mistakes: [{ ...result.mistakes[0], correction: 42 }],
    }],
  ])("rejects malformed analysis before live reduction or persistence: %s", async (_name, value) => {
    const store = await FluencyStore.open(root);
    const malformed = value as unknown as AnalysisResult;

    await expect(store.appendAnalysis(collected("malformed"), malformed)).rejects.toThrow();
    expect(store.hasProcessedPromptHash("malformed")).toBe(false);
    expect(await readFile(join(root, "history.jsonl"), "utf8")).toBe("");
    expect((await FluencyStore.open(root)).hasProcessedPromptHash("malformed")).toBe(false);
  });

  it("stores zero-mistake English words but no non-English observation", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("english", 100, "This prompt has six useful English words."), {
      schemaVersion: 3,
      language: "en",
      mistakes: [],
      demonstratedFixes: [],
    });
    await store.appendAnalysis(collected("russian", 100, "Это сообщение написано по-русски."), {
      schemaVersion: 3,
      language: "other",
      mistakes: [],
      demonstratedFixes: [],
    });

    expect(observation(store, "english")).toMatchObject({
      promptHash: "english",
      wordCount: 7,
      occurrenceIds: [],
    });
    expect(observation(store, "russian")).toBeUndefined();
    expect(store.hasProcessedPromptHash("english")).toBe(true);
    expect(store.hasProcessedPromptHash("russian")).toBe(true);
  });

  it("never persists full English or non-English prompt prose in analysis events", async () => {
    const store = await FluencyStore.open(root);
    const english = {
      promptHash: "private-english-hash",
      observedAt: 100,
      prose: "Unique English persistence canary must never reach history.",
    };
    const other = {
      promptHash: "private-other-hash",
      observedAt: 110,
      prose: "Уникальный русский маркер не должен попасть в историю.",
    };
    await store.appendAnalysis(english, { schemaVersion: 3, language: "en", mistakes: [], demonstratedFixes: [] });
    await store.appendAnalysis(other, { schemaVersion: 3, language: "other", mistakes: [], demonstratedFixes: [] });
    const evidence = "Unique demonstrated-fix evidence canary must not persist.";
    await store.appendAnalysis({ promptHash: "fix-evidence-hash", observedAt: 120, prose: "I now use this grammar correctly." }, {
      schemaVersion: 3,
      language: "en",
      mistakes: [],
      demonstratedFixes: [{ patternKey: "privacy.fix", evidence, confidence: 0.9 }],
    });

    const history = await readFile(join(root, "history.jsonl"), "utf8");
    expect(history).not.toContain(english.prose);
    expect(history).not.toContain(other.prose);
    expect(history).not.toContain(evidence);
    expect(history).toContain(english.promptHash);
    expect(history).toContain(other.promptHash);

    const reopened = await FluencyStore.open(root);
    expect(observation(reopened, english.promptHash)?.wordCount).toBe(8);
    expect(observation(reopened, other.promptHash)).toBeUndefined();
    for (const hash of [english.promptHash, other.promptHash, "fix-evidence-hash"]) {
      expect(reopened.hasProcessedPromptHash(hash)).toBe(true);
    }
  });

  it("creates deterministic pending occurrences for every finding", async () => {
    const store = await FluencyStore.open(root);
    const prompt = collected("occurrences", 123, "I want an parallel agent with bad punctuation");
    const second = { ...result.mistakes[0]!, patternKey: "mechanics.punctuation.missing-period", errorType: "M:PUNCT" as const };
    await store.appendAnalysis(prompt, { ...result, mistakes: [result.mistakes[0]!, second] });

    expect(occurrences(store)).toEqual([
      expect.objectContaining({ id: "occurrences:0", promptHash: "occurrences", patternKey: result.mistakes[0]!.patternKey, decision: "pending", observedAt: 123 }),
      expect.objectContaining({ id: "occurrences:1", promptHash: "occurrences", patternKey: second.patternKey, decision: "pending", observedAt: 123 }),
    ]);
    expect(observation(store, "occurrences")?.occurrenceIds).toEqual(["occurrences:0", "occurrences:1"]);

    await store.compact();
    const reopened = await FluencyStore.open(root);
    expect(observation(reopened, "occurrences")?.wordCount).toBe(8);
    expect(occurrences(reopened)).toEqual(occurrences(store));
    const compacted = await readFile(join(root, "history.jsonl"), "utf8");
    expect(JSON.parse(compacted)).toMatchObject({ type: "snapshot", schemaVersion: 4 });
    expect(compacted).toContain('"observations"');
    expect(compacted).toContain('"occurrences"');
  });

  it("deduplicates repeated patterns and persists transitions", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("hash-1", 100), result);
    await store.appendAnalysis(collected("hash-2", 200), result);
    const [pattern] = store.listInbox();
    expect(pattern?.occurrenceCount).toBe(2);

    await store.acceptPattern(pattern!.id, 300);
    const reopened = await FluencyStore.open(root);
    expect(reopened.listAccepted()[0]).toMatchObject({ id: pattern!.id, acceptedCount: 2, pendingCount: 0 });
  });

  it("derives durable progress while reviewed rules reopen on recurrence", async () => {
    const store = await FluencyStore.open(root);
    const pendingOneKey = "progress.pending-one";
    const pendingTwoKey = "progress.pending-two";
    const ignoredNewKey = "progress.ignored-new";
    const learnedPatternKey = "progress.learned-recurrence";
    const dismissedKey = "progress.dismissed";

    await store.appendAnalysis(collected("pending-1", 100), resultFor(pendingOneKey));
    await store.appendAnalysis(collected("pending-2", 110), resultFor(pendingTwoKey));
    await store.appendAnalysis(collected("pending-1-repeat", 120), resultFor(pendingOneKey));
    await store.appendAnalysis(collected("ignored-new", 130), resultFor(ignoredNewKey));
    await store.ignorePatternKey(ignoredNewKey);

    await store.appendAnalysis(collected("learned", 140), resultFor(learnedPatternKey, "R:PREP"));
    const learnedPattern = store.listInbox().find((pattern) => pattern.patternKey === learnedPatternKey)!;
    await store.acceptPattern(learnedPattern.id, 150);
    await store.ignoreCategory("PREP");

    await store.appendAnalysis(collected("dismissed", 160), resultFor(dismissedKey));
    const dismissedPattern = store.listInbox().find((pattern) => pattern.patternKey === dismissedKey)!;
    await store.dismissPattern(dismissedPattern.id, 170);
    await store.appendAnalysis(collected("dismissed-recurrence", 180), resultFor(dismissedKey));

    expect(patterns(store)).toHaveLength(5);
    expect(patterns(store).find((pattern) => pattern.patternKey === pendingOneKey)?.occurrenceCount).toBe(2);
    expect(store.listInbox()).toHaveLength(3);
    expect(store.listReviewPatterns().filter((pattern) => pattern.acceptedCount > 0)).toHaveLength(1);

    await store.restoreIgnoreTargets({ patternKeys: [], categories: ["PREP"] });
    await store.appendAnalysis(collected("recurrence", 400), resultFor(learnedPatternKey));
    expect(store.listInbox()).toHaveLength(4);
    expect(store.listReviewPatterns().filter((pattern) => pattern.acceptedCount > 0)).toHaveLength(1);

    const reopened = await FluencyStore.open(root);
    expect(reopened.listInbox()).toHaveLength(4);
    expect(reopened.listReviewPatterns().filter((pattern) => pattern.acceptedCount > 0)).toHaveLength(1);
  });

  it("removes terminal controls before analysis persistence and replay", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("terminal-safe", 123), {
      schemaVersion: 3,
      language: "en",
      mistakes: [{
        ...result.mistakes[0]!,
        original: "an\u001b[31m parallel agent",
        correction: "a\u0007 parallel agent",
        sourceExcerpt: "I want an\u001b[2J parallel agent.",
        correctedExcerpt: "I want a\u007f parallel agent.",
        explanation: "Use a.\u001b[0m",
        patternKey: "grammar.articles.a-before-consonant\u001b[0m",
      }],
      demonstratedFixes: [{
        patternKey: "grammar.articles.a-before-consonant\u001b[0m",
        evidence: "a parallel\u0000 agent",
        confidence: 0.99,
      }],
    });
    const history = await readFile(join(root, "history.jsonl"), "utf8");
    expect(history).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    const reopened = await FluencyStore.open(root);
    expect(reopened.listInbox()[0]?.explanation).toBe("Use a.");
  });

  it("round-trips product state without duplicate analysis payload and clears fully", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("hash-latest", 123), result);
    await store.compact();
    const reopened = await FluencyStore.open(root);
    expect(await readFile(join(root, "history.jsonl"), "utf8")).not.toContain("latestAnalysis");
    expect(observation(reopened, "hash-latest")).toBeDefined();
    await reopened.clear();
    expect(reopened.getAnalyticsSnapshot().observations).toEqual([]);
    expect(reopened.getAnalyticsSnapshot().occurrences).toEqual([]);
    expect((await FluencyStore.open(root)).getAnalyticsSnapshot().patterns).toEqual([]);
  });

  it("skips analysis timestamps that cannot produce a local calendar date", async () => {
    await writeFile(join(root, "history.jsonl"), [
      JSON.stringify(historyAnalysis("valid-before", result, 100)),
      JSON.stringify(historyAnalysis("invalid-date", result, 1e308)),
      "",
    ].join("\n"));

    const store = await FluencyStore.open(root);
    expect(store.hasProcessedPromptHash("valid-before")).toBe(true);
    expect(store.hasProcessedPromptHash("invalid-date")).toBe(false);
    expect(store.getWarnings()).toEqual(["Skipped 1 corrupt history line"]);
    await store.compact(200);
    expect((await FluencyStore.open(root)).hasProcessedPromptHash("valid-before")).toBe(true);
  });

  it("skips corrupt lines and keeps valid events", async () => {
    await writeFile(join(root, "history.jsonl"), `${JSON.stringify(historyAnalysis("hash-1"))}\nnot-json\n`);
    const store = await FluencyStore.open(root);
    expect(store.listInbox()).toHaveLength(1);
    expect(store.getWarnings()).toEqual(["Skipped 1 corrupt history line"]);
  });

  it("replays each valid-JSON line transactionally", async () => {
    const malformedAnalysis = {
      schemaVersion: 4,
      type: "analysis",
      at: 200,
      prompt: collected("hash-partial", 200),
      wordCount: 5,
      result: {
        ...result,
        mistakes: [
          { ...result.mistakes[0]!, patternKey: "grammar.articles.partial" },
          null,
        ],
      },
    };
    const malformedSnapshot = {
      schemaVersion: 4,
      type: "snapshot",
      at: 300,
      patterns: [],
      processedPromptHashes: null,
    };
    await writeFile(join(root, "history.jsonl"), [
      JSON.stringify(historyAnalysis("hash-valid")),
      JSON.stringify(malformedAnalysis),
      JSON.stringify(malformedSnapshot),
      "",
    ].join("\n"));

    const store = await FluencyStore.open(root);
    expect(store.hasProcessedPromptHash("hash-valid")).toBe(true);
    expect(store.hasProcessedPromptHash("hash-partial")).toBe(false);
    expect(patterns(store)).toHaveLength(1);
    expect(store.listInbox()[0]?.occurrenceCount).toBe(1);
    expect(store.getWarnings()).toEqual(["Skipped 2 corrupt history lines"]);
  });

  it("rejects malformed review decisions transactionally", async () => {
    const analysis = historyAnalysis("review-hash");
    const occurrenceId = "review-hash:0";
    await writeFile(join(root, "history.jsonl"), [
      JSON.stringify(analysis),
      JSON.stringify({ schemaVersion: 4, type: "review", at: 101, occurrenceIds: [occurrenceId], decision: "invalid" }),
      "",
    ].join("\n"));

    const store = await FluencyStore.open(root);
    expect(occurrences(store).find((item) => item.id === occurrenceId)?.decision).toBe("pending");
    expect(store.getWarnings()).toEqual(["Skipped 1 corrupt history line"]);
  });

  it.each<[string, SnapshotMutator]>([
    ["invalid occurrence decision", replaceFirstSnapshotField("occurrences", "decision", "invalid")],
    ["broken observation reference", replaceFirstSnapshotField("observations", "occurrenceIds", ["missing:0"])],
  ])("rejects schema-v4 snapshots with %s", async (_name, mutate) => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("snapshot-hash"), result);
    await store.compact();
    const historyPath = join(root, "history.jsonl");
    const snapshot: unknown = JSON.parse((await readFile(historyPath, "utf8")).trim());
    const malformed = mutate(snapshot);
    await writeFile(historyPath, `${JSON.stringify(malformed)}\n`);

    const reopened = await FluencyStore.open(root);
    expect(reopened.getAnalyticsSnapshot().observations).toEqual([]);
    expect(reopened.getAnalyticsSnapshot().occurrences).toEqual([]);
    expect(reopened.getWarnings()).toEqual(["Skipped 1 corrupt history line"]);
  });

  it("rejects removed state events without poisoning compaction", async () => {
    await writeFile(join(root, "history.jsonl"), [
      JSON.stringify(historyAnalysis("state-valid")),
      JSON.stringify({ schemaVersion: 4, type: "state", at: 101, patternId: "missing", state: "learned" }),
      "",
    ].join("\n"));

    const store = await FluencyStore.open(root);
    expect(patterns(store)).toHaveLength(1);
    expect(store.getWarnings()).toEqual(["Skipped 1 corrupt history line"]);
    await store.compact();
    const reopened = await FluencyStore.open(root);
    expect(reopened.listInbox()).toHaveLength(1);
    expect(reopened.getWarnings()).toEqual([]);
  });

  it("writes state-free schema-v4 patterns and replays explicit review markers", async () => {
    const store = await FluencyStore.open(root);
    const now = Date.now();
    await store.appendAnalysis(collected("state-free-accepted", now), resultFor("state.free"));
    const pattern = store.listInbox()[0]!;
    await store.acceptPattern(pattern.id, now);
    await store.appendAnalysis(collected("state-free-pending", now + 1), resultFor("state.free"));
    await store.compact(now + 2);

    const snapshot = JSON.parse((await readFile(join(root, "history.jsonl"), "utf8")).trim()) as {
      patterns: Array<Record<string, unknown>>;
    };
    expect(snapshot.patterns.every((item) => !("state" in item))).toBe(true);

    const reopened = await FluencyStore.open(root);
    expect(reopened.listInbox()[0]).toMatchObject({ id: pattern.id, pendingCount: 1, acceptedCount: 1 });
    expect(reopened.listAccepted()[0]).toMatchObject({ id: pattern.id, pendingCount: 1, acceptedCount: 1 });
  });

  it("exposes one occurrence-driven review model without legacy state", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("canonical-review"), result);
    const [pattern] = store.listReviewPatterns();
    expect(pattern).toMatchObject({ pendingCount: 1, acceptedCount: 0, dismissedCount: 0 });
    expect(pattern).not.toHaveProperty("state");
    expect(pattern).not.toHaveProperty("legacyAccepted");
    await store.compact();
    const persisted = await readFile(join(root, "history.jsonl"), "utf8");
    expect(persisted).not.toContain("legacyAcceptedPatternIds");
    expect(persisted).not.toContain("legacyPendingPatternIds");
    expect(persisted).not.toContain('"state"');
  });

  it("lists recent pending and accepted rules while excluding ignored and dismissed batches", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("pending", 100), resultFor("known.pending"));
    await store.appendAnalysis(collected("learned", 200), resultFor("known.learned"));
    const learned = store.listInbox().find((pattern) => pattern.patternKey === "known.learned")!;
    await store.acceptPattern(learned.id, 210);
    await store.appendAnalysis(collected("ignored", 300), resultFor("known.ignored"));
    await store.ignorePatternKey("known.ignored");
    await store.appendAnalysis(collected("dismissed", 400), resultFor("known.dismissed"));
    const dismissed = store.listInbox().find((pattern) => pattern.patternKey === "known.dismissed")!;
    await store.dismissPattern(dismissed.id, 410);

    expect(store.listKnownPatterns().map((pattern) => pattern.patternKey)).toEqual([
      "known.learned",
      "known.pending",
    ]);
  });

  it("accepts only the current pending batch and reopens on recurrence", async () => {
    const store = await FluencyStore.open(root);
    const key = "review.accepted-recurrence";
    await store.appendAnalysis(collected("accept-1", 100), resultFor(key));
    await store.appendAnalysis(collected("accept-2", 110), resultFor(key));
    const pattern = store.listInbox()[0]!;

    await store.acceptPattern(pattern.id, 120);
    expect(store.listInbox()).toEqual([]);
    expect(store.listAccepted()[0]).toMatchObject({ acceptedCount: 2, pendingCount: 0 });

    await store.appendAnalysis(collected("accept-3", 130), resultFor(key));
    expect(store.listInbox()[0]).toMatchObject({ acceptedCount: 2, pendingCount: 1 });
    expect(store.listAccepted()[0]).toMatchObject({ acceptedCount: 2, pendingCount: 1 });
  });

  it("dismisses only the current batch and future recurrence reopens", async () => {
    const store = await FluencyStore.open(root);
    const key = "review.dismissed-recurrence";
    await store.appendAnalysis(collected("dismiss-1", 100), resultFor(key));
    const pattern = store.listInbox()[0]!;

    await store.dismissPattern(pattern.id, 110);
    expect(store.listInbox()).toEqual([]);
    expect(store.listAccepted()).toEqual([]);

    await store.appendAnalysis(collected("dismiss-2", 120), resultFor(key));
    expect(store.listInbox()[0]).toMatchObject({ dismissedCount: 1, pendingCount: 1 });
  });

  it("keeps accepted history counted when a later ignore hides pending recurrence", async () => {
    const store = await FluencyStore.open(root);
    const key = "review.accepted-then-ignored";
    await store.appendAnalysis(collected("ignored-accept", 100), resultFor(key));
    const pattern = store.listInbox()[0]!;
    await store.acceptPattern(pattern.id, 110);
    await store.appendAnalysis(collected("ignored-pending", 120), resultFor(key));
    await store.ignorePatternKey(key);

    expect(store.listInbox()).toEqual([]);
    expect(store.listAccepted()).toEqual([]);
    expect(store.listIgnored()[0]).toMatchObject({ acceptedCount: 1, pendingCount: 1 });
    expect(occurrences(store).filter((item) => item.decision === "accepted")).toHaveLength(1);

    await store.restoreIgnoreTargets({ patternKeys: [key], categories: [] });
    expect(store.listInbox()[0]).toMatchObject({ acceptedCount: 1, pendingCount: 1 });
  });

  it("projects exact review counts across many patterns and decisions", async () => {
    const store = await FluencyStore.open(root);
    for (let index = 0; index < 40; index += 1) {
      await store.appendAnalysis(
        collected(`projection-${index}`, 100 + index),
        resultFor(`projection.rule-${index % 10}`),
      );
    }
    for (const item of store.listInbox().slice(0, 3)) await store.acceptPattern(item.id, 200);
    for (const item of store.listInbox().slice(0, 2)) await store.dismissPattern(item.id, 201);

    const projected = store.listReviewPatterns();
    expect(projected).toHaveLength(10);
    expect(projected.reduce((sum, item) => sum + item.pendingCount, 0)).toBe(20);
    expect(projected.reduce((sum, item) => sum + item.acceptedCount, 0)).toBe(12);
    expect(projected.reduce((sum, item) => sum + item.dismissedCount, 0)).toBe(8);
  });

  it("does not process a prompt hash twice", async () => {
    const store = await FluencyStore.open(root);
    await store.appendAnalysis(collected("hash-1", 100), result);
    await store.appendAnalysis(collected("hash-1", 200), result);
    expect(store.listInbox()[0]?.occurrenceCount).toBe(1);
  });
});
