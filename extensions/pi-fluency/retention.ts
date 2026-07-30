import { HISTORY_SCHEMA_VERSION, type FluencyEvent, type FluencyState } from "./types.js";
import { copyObservation, copyOccurrence, copyPattern, localDateKey } from "./state-reducer.js";

export type SnapshotHistoryEvent = Extract<FluencyEvent, { type: "snapshot" }>;

function shiftLocalDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function buildRetainedSnapshot(
  state: FluencyState,
  options: { now: number; retentionLimit: number },
): SnapshotHistoryEvent {
  const hashLimit = Math.max(0, Math.floor(options.retentionLimit * 10));
  const reviewedCutoff = shiftLocalDate(localDateKey(options.now), -364);
  const occurrences = [...state.occurrences.values()]
    .filter((occurrence) => occurrence.decision === "pending" || occurrence.localDate >= reviewedCutoff)
    .map(copyOccurrence);
  const retainedOccurrenceIds = new Set(occurrences.map((occurrence) => occurrence.id));
  const observations = [...state.observations.values()]
    .filter((observation) => observation.localDate >= reviewedCutoff
      || observation.occurrenceIds.some((id) => retainedOccurrenceIds.has(id)))
    .map((observation) => ({
      ...copyObservation(observation),
      occurrenceIds: observation.occurrenceIds.filter((id) => retainedOccurrenceIds.has(id)),
    }));
  const retainedPatternIds = new Set(occurrences.map((occurrence) => occurrence.patternId));
  const patterns = [...state.patterns.values()]
    .filter((pattern) => retainedPatternIds.has(pattern.id))
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .map(copyPattern);
  const recentHashes = hashLimit === 0 ? [] : [...state.processedPromptHashes].slice(-hashLimit);
  const processedPromptHashes = [...new Set([
    ...observations.map((observation) => observation.promptHash),
    ...recentHashes,
  ])];

  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    type: "snapshot",
    at: options.now,
    patterns,
    observations,
    occurrences,
    processedPromptHashes,
  };
}
