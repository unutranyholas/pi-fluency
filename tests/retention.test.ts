import { describe, expect, it } from "vitest";
import { buildRetainedSnapshot } from "../extensions/pi-fluency/retention.js";
import { createFluencyState } from "../extensions/pi-fluency/state-reducer.js";
import type { MistakeOccurrence, MistakePattern } from "../extensions/pi-fluency/types.js";

function pattern(id: string): MistakePattern {
  return {
    id,
    patternKey: `grammar.rule.${id}`,
    original: "wrong",
    correction: "right",
    sourceExcerpt: "wrong text",
    correctedExcerpt: "right text",
    explanation: `Rule ${id}`,
    errorType: "R:OTHER",
    confidence: 0.9,
    firstSeenAt: 1,
    lastSeenAt: 1,
    occurrenceCount: 1,
    demonstratedFixCount: 0,
  };
}

function addOccurrence(
  state: ReturnType<typeof createFluencyState>,
  id: string,
  localDate: string,
  decision: MistakeOccurrence["decision"],
): void {
  const promptHash = `prompt-${id}`;
  const occurrenceId = `${promptHash}:0`;
  const value: MistakeOccurrence = {
    id: occurrenceId,
    promptHash,
    patternId: id,
    patternKey: `grammar.rule.${id}`,
    observedAt: 1,
    localDate,
    decision,
  };
  state.patterns.set(id, pattern(id));
  state.occurrences.set(occurrenceId, value);
  state.observations.set(promptHash, {
    promptHash,
    observedAt: 1,
    localDate,
    wordCount: 4,
    occurrenceIds: [occurrenceId],
  });
  state.processedPromptHashes.add(promptHash);
}

describe("retention snapshot builder", () => {
  it("retains all pending and exactly 365 local calendar days of reviewed occurrences", () => {
    const state = createFluencyState();
    addOccurrence(state, "pending-old", "2020-01-01", "pending");
    addOccurrence(state, "accepted-boundary", "2025-07-27", "accepted");
    addOccurrence(state, "dismissed-expired", "2025-07-26", "dismissed");

    const snapshot = buildRetainedSnapshot(state, {
      now: new Date(2026, 6, 26).getTime(),
      retentionLimit: 500,
    });

    expect(snapshot.occurrences.map((item) => item.patternId).sort()).toEqual(["accepted-boundary", "pending-old"]);
    expect(snapshot.patterns.map((item) => item.id).sort()).toEqual(["accepted-boundary", "pending-old"]);
    expect(snapshot.observations.map((item) => item.promptHash).sort()).toEqual([
      "prompt-accepted-boundary",
      "prompt-pending-old",
    ]);
  });

  it("keeps recent zero-finding English denominators", () => {
    const state = createFluencyState();
    state.observations.set("zero", {
      promptHash: "zero",
      observedAt: 1,
      localDate: "2026-07-26",
      wordCount: 8,
      occurrenceIds: [],
    });
    state.processedPromptHashes.add("zero");

    const snapshot = buildRetainedSnapshot(state, {
      now: new Date(2026, 6, 26).getTime(),
      retentionLimit: 1,
    });
    expect(snapshot.observations).toEqual([expect.objectContaining({ promptHash: "zero", wordCount: 8 })]);
  });

  it("preserves every referenced hash while bounding only unreferenced hashes", () => {
    const state = createFluencyState();
    addOccurrence(state, "pending", "2020-01-01", "pending");
    for (let index = 0; index < 15; index += 1) state.processedPromptHashes.add(`unreferenced-${index}`);

    const snapshot = buildRetainedSnapshot(state, {
      now: new Date(2026, 6, 26).getTime(),
      retentionLimit: 1,
    });
    expect(snapshot.processedPromptHashes).toEqual([
      "prompt-pending",
      ...Array.from({ length: 10 }, (_, index) => `unreferenced-${index + 5}`),
    ]);
  });

  it("does not mutate source collections or nested observations", () => {
    const state = createFluencyState();
    addOccurrence(state, "pending", "2020-01-01", "pending");
    const before = JSON.stringify([...state.observations]);
    const snapshot = buildRetainedSnapshot(state, {
      now: new Date(2026, 6, 26).getTime(),
      retentionLimit: 1,
    });
    snapshot.observations[0]!.occurrenceIds.length = 0;
    expect(JSON.stringify([...state.observations])).toBe(before);
  });
});
