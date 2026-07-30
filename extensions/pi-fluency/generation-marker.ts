const HISTORY_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HistoryGenerationMarker {
  generation: string;
  resetPending: boolean;
  legacy: boolean;
}

function invalid(): never {
  throw new Error("Invalid history generation");
}

function validGeneration(value: unknown): value is string {
  return typeof value === "string" && HISTORY_GENERATION.test(value);
}

export function decodeHistoryGenerationMarker(serialized: string): HistoryGenerationMarker {
  const trimmed = serialized.trim();
  if (validGeneration(trimmed)) {
    return { generation: trimmed, resetPending: false, legacy: true };
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  if (
    keys.length !== 2
    || keys[0] !== "generation"
    || keys[1] !== "resetPending"
    || !validGeneration(marker.generation)
    || typeof marker.resetPending !== "boolean"
  ) return invalid();
  return { generation: marker.generation, resetPending: marker.resetPending, legacy: false };
}

export function encodeHistoryGenerationMarker(marker: {
  generation: string;
  resetPending: boolean;
}): string {
  if (!validGeneration(marker.generation)) return invalid();
  return `${JSON.stringify({
    generation: marker.generation,
    resetPending: marker.resetPending,
  })}\n`;
}
