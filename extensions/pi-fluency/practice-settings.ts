import { createHash } from "node:crypto";
import {
  DEFAULT_PRACTICE_SETTINGS,
  PRACTICE_SCHEMA_VERSION,
  type PracticeSettings,
  type PracticeTarget,
} from "./types.js";

export const MAX_PRACTICE_TARGETS = 50;
export const MAX_PRACTICE_FIELD_LENGTH = 500;
export const MAX_PRACTICE_MEMBER_KEYS = 500;
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
export const PRACTICE_SESSION_ENTRY_TYPE = "pi-fluency-practice-snooze";
export const PRACTICE_SESSION_RESUME_ENTRY_TYPE = "pi-fluency-practice-resume";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const PRACTICE_KEYS = new Set([
  "schemaVersion",
  "revision",
  "epoch",
  "enabled",
  "consentedAt",
  "targets",
  "snoozedUntil",
]);
const TARGET_KEYS = new Set(["explanation", "memberPatternKeys"]);
const SESSION_SNOOZE_KEYS = new Set(["schemaVersion", "epoch", "sessionHash"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPracticeField(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PRACTICE_FIELD_LENGTH
    && !CONTROL_CHARACTER.test(value);
}

export function canonicalizePracticeTargets(value: unknown): PracticeTarget[] {
  if (!Array.isArray(value) || value.length > MAX_PRACTICE_TARGETS) {
    throw new Error("Invalid practice settings");
  }

  const membersByExplanation = new Map<string, Set<string>>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, TARGET_KEYS)
      || !isPracticeField(candidate.explanation)
      || !Array.isArray(candidate.memberPatternKeys)
      || candidate.memberPatternKeys.length === 0
      || candidate.memberPatternKeys.length > MAX_PRACTICE_MEMBER_KEYS
      || candidate.memberPatternKeys.some((key) => !isPracticeField(key))) {
      throw new Error("Invalid practice settings");
    }
    const members = membersByExplanation.get(candidate.explanation) ?? new Set<string>();
    for (const key of candidate.memberPatternKeys as string[]) members.add(key);
    if (members.size > MAX_PRACTICE_MEMBER_KEYS) throw new Error("Invalid practice settings");
    membersByExplanation.set(candidate.explanation, members);
  }

  return [...membersByExplanation]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([explanation, memberPatternKeys]) => ({
      explanation,
      memberPatternKeys: [...memberPatternKeys].sort((left, right) => left.localeCompare(right)),
    }));
}

export function copyPracticeSettings(settings: PracticeSettings): PracticeSettings {
  return {
    ...settings,
    targets: settings.targets.map((target) => ({
      explanation: target.explanation,
      memberPatternKeys: [...target.memberPatternKeys],
    })),
  };
}

export function defaultPracticeSettings(): PracticeSettings {
  return copyPracticeSettings(DEFAULT_PRACTICE_SETTINGS);
}

export function decodePracticeSettings(value: unknown): PracticeSettings {
  if (!isRecord(value) || !hasOnlyKeys(value, PRACTICE_KEYS)
    || value.schemaVersion !== PRACTICE_SCHEMA_VERSION
    || !isCounter(value.revision)
    || !isCounter(value.epoch)
    || typeof value.enabled !== "boolean"
    || (value.consentedAt !== undefined && !isTimestamp(value.consentedAt))
    || (value.snoozedUntil !== undefined && !isTimestamp(value.snoozedUntil))) {
    throw new Error("Invalid practice settings");
  }

  const targets = canonicalizePracticeTargets(value.targets);
  return {
    schemaVersion: PRACTICE_SCHEMA_VERSION,
    revision: value.revision,
    epoch: value.epoch,
    enabled: value.enabled,
    targets,
    ...(value.consentedAt === undefined ? {} : { consentedAt: value.consentedAt }),
    ...(value.snoozedUntil === undefined ? {} : { snoozedUntil: value.snoozedUntil }),
  };
}

export function isGloballySnoozed(settings: PracticeSettings, now = Date.now()): boolean {
  return settings.snoozedUntil !== undefined && settings.snoozedUntil > now;
}

export interface PracticeSessionSnoozeEntry {
  schemaVersion: typeof PRACTICE_SCHEMA_VERSION;
  epoch: number;
  sessionHash: string;
}

export interface CustomSessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

export function hashPracticeSessionFile(sessionFile: string): string {
  return createHash("sha256").update(sessionFile).digest("hex");
}

function decodeSessionSnooze(value: unknown): PracticeSessionSnoozeEntry | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, SESSION_SNOOZE_KEYS)
    || value.schemaVersion !== PRACTICE_SCHEMA_VERSION
    || !isCounter(value.epoch)
    || typeof value.sessionHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sessionHash)) return undefined;
  return {
    schemaVersion: PRACTICE_SCHEMA_VERSION,
    epoch: value.epoch,
    sessionHash: value.sessionHash,
  };
}

/** Runtime owner for durable session-file snooze and ephemeral-session fallback. */
export class PracticeSessionSnooze {
  private ephemeralEpoch: number | undefined;

  restore(entries: readonly CustomSessionEntryLike[], sessionFile: string | undefined, epoch: number): boolean {
    if (sessionFile === undefined) return this.ephemeralEpoch === epoch;
    const expectedHash = hashPracticeSessionFile(sessionFile);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.type !== "custom"
        || (entry.customType !== PRACTICE_SESSION_ENTRY_TYPE
          && entry.customType !== PRACTICE_SESSION_RESUME_ENTRY_TYPE)) continue;
      const data = decodeSessionSnooze(entry.data);
      if (data?.epoch !== epoch || data.sessionHash !== expectedHash) continue;
      return entry.customType === PRACTICE_SESSION_ENTRY_TYPE;
    }
    return false;
  }

  snooze(
    sessionFile: string | undefined,
    epoch: number,
    appendEntry: (customType: string, data: PracticeSessionSnoozeEntry) => void,
  ): void {
    if (sessionFile === undefined) {
      this.ephemeralEpoch = epoch;
      return;
    }
    appendEntry(PRACTICE_SESSION_ENTRY_TYPE, {
      schemaVersion: PRACTICE_SCHEMA_VERSION,
      epoch,
      sessionHash: hashPracticeSessionFile(sessionFile),
    });
  }

  resume(
    sessionFile: string | undefined,
    epoch: number,
    appendEntry: (customType: string, data: PracticeSessionSnoozeEntry) => void,
  ): void {
    if (sessionFile === undefined) {
      this.ephemeralEpoch = undefined;
      return;
    }
    appendEntry(PRACTICE_SESSION_RESUME_ENTRY_TYPE, {
      schemaVersion: PRACTICE_SCHEMA_VERSION,
      epoch,
      sessionHash: hashPracticeSessionFile(sessionFile),
    });
  }
}
