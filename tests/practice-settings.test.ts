import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FIVE_HOURS_MS,
  MAX_PRACTICE_FIELD_LENGTH,
  PRACTICE_SESSION_ENTRY_TYPE,
  PRACTICE_SESSION_RESUME_ENTRY_TYPE,
  PracticeSessionSnooze,
  canonicalizePracticeTargets,
  decodePracticeSettings,
  hashPracticeSessionFile,
  isGloballySnoozed,
} from "../extensions/pi-fluency/practice-settings.js";
import { FluencyStore } from "../extensions/pi-fluency/store.js";
import { DEFAULT_PRACTICE_SETTINGS, DEFAULT_SETTINGS } from "../extensions/pi-fluency/types.js";
import { createStoreRoot } from "./helpers/store-fixtures.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await createStoreRoot());
});

afterEach(async () => {
  await cleanup();
});

const target = (explanation: string, ...memberPatternKeys: string[]) => ({
  explanation,
  memberPatternKeys,
});

describe("practice settings codec", () => {
  it("canonicalizes duplicate explanations and member keys deterministically", () => {
    expect(canonicalizePracticeTargets([
      target("Use articles", "z.key", "a.key", "a.key"),
      target("Agreement", "v.key"),
      target("Use articles", "m.key"),
    ])).toEqual([
      target("Agreement", "v.key"),
      target("Use articles", "a.key", "m.key", "z.key"),
    ]);
  });

  it.each([
    ["unsupported version", { ...DEFAULT_PRACTICE_SETTINGS, schemaVersion: 2 }],
    ["unknown property", { ...DEFAULT_PRACTICE_SETTINGS, extra: true }],
    ["non-finite timestamp", { ...DEFAULT_PRACTICE_SETTINGS, consentedAt: Number.NaN }],
    ["control in label", { ...DEFAULT_PRACTICE_SETTINGS, targets: [target("bad\u001b", "key")] }],
    ["empty member array", { ...DEFAULT_PRACTICE_SETTINGS, targets: [target("label")] }],
    ["oversized field", { ...DEFAULT_PRACTICE_SETTINGS, targets: [target("x".repeat(MAX_PRACTICE_FIELD_LENGTH + 1), "key")] }],
    ["oversized targets", { ...DEFAULT_PRACTICE_SETTINGS, targets: Array.from({ length: 51 }, (_, index) => target(`label-${index}`, `key-${index}`)) }],
  ])("rejects malformed state: %s", (_name, value) => {
    expect(() => decodePracticeSettings(value)).toThrow("Invalid practice settings");
  });

  it("reports only future global snoozes as active", () => {
    expect(isGloballySnoozed({ ...DEFAULT_PRACTICE_SETTINGS, snoozedUntil: 101 }, 100)).toBe(true);
    expect(isGloballySnoozed({ ...DEFAULT_PRACTICE_SETTINGS, snoozedUntil: 100 }, 100)).toBe(false);
  });
});

describe("FluencyStore practice sidecar", () => {
  it("opens missing sidecar as disabled defaults without changing settings v3", async () => {
    const settings = { ...DEFAULT_SETTINGS, modelId: "unchanged-model" };
    const serialized = JSON.stringify(settings);
    await writeFile(join(root, "settings.json"), serialized);

    const store = await FluencyStore.open(root);
    expect(store.getPracticeSettings()).toEqual(DEFAULT_PRACTICE_SETTINGS);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(serialized);
  });

  it("round-trips immutable consent, master state, targets, and snooze in private file", async () => {
    const store = await FluencyStore.open(root);
    await store.recordPracticeConsent(123);
    await store.setPracticeEnabled(true);
    await store.setPracticeTarget(target("Use articles", "det.article", "det.article"), true);
    const beforeSnooze = store.getPracticeSettings();
    await expect(store.snoozePracticeForFiveHours(beforeSnooze.revision, Date.now() + 1_000, 500)).resolves.toBe(true);

    const returned = store.getPracticeSettings();
    returned.targets[0]!.memberPatternKeys.push("external.alias");
    const reopened = await FluencyStore.open(root);
    expect(reopened.getPracticeSettings()).toEqual({
      schemaVersion: 1,
      revision: 4,
      epoch: 0,
      enabled: true,
      consentedAt: 123,
      targets: [target("Use articles", "det.article")],
      snoozedUntil: 500 + FIVE_HOURS_MS,
    });
    expect((await stat(join(root, "practice.json"))).mode & 0o777).toBe(0o600);
  });

  it("writes private temporary files and updates projection only after atomic replacement", async () => {
    const store = await FluencyStore.open(root);
    await store.setPracticeEnabled(true);
    const path = join(root, "practice.json");
    const before = await readFile(path, "utf8");

    type FileReplacer = (temporary: string, destination: string) => Promise<void>;
    const storeClass = FluencyStore as unknown as { practiceFileReplacer: FileReplacer };
    const originalReplacer = storeClass.practiceFileReplacer;
    let temporaryMode: number | undefined;
    storeClass.practiceFileReplacer = async (temporary) => {
      temporaryMode = (await stat(temporary)).mode & 0o777;
      throw new Error("Injected practice replacement failure");
    };
    try {
      await expect(store.recordPracticeConsent(999)).rejects.toThrow("Injected practice replacement failure");
      expect(temporaryMode).toBe(0o600);
      expect(await readFile(path, "utf8")).toBe(before);
      expect(store.getPracticeSettings()).toEqual({ ...DEFAULT_PRACTICE_SETTINGS, revision: 1, enabled: true });
    } finally {
      storeClass.practiceFileReplacer = originalReplacer;
    }
  });

  it("hardens an existing sidecar and loads corrupt state as bounded safe defaults", async () => {
    const path = join(root, "practice.json");
    await writeFile(path, '{"schemaVersion":99}', { mode: 0o666 });
    await chmod(path, 0o666);

    const store = await FluencyStore.open(root);
    expect(store.getPracticeSettings()).toEqual(DEFAULT_PRACTICE_SETTINGS);
    expect(store.getWarnings()).toContain("Could not read practice settings; defaults loaded");
    expect(store.getWarnings().filter((warning) => warning.includes("practice settings"))).toHaveLength(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe('{"schemaVersion":99}');
  });

  it("increments revision for mutations and epoch only for Reset", async () => {
    const store = await FluencyStore.open(root);
    await store.recordPracticeConsent(10);
    await store.setPracticeEnabled(true);
    await store.setPracticeTarget(target("Rule", "rule.key"), true);
    await store.resumePractice();
    expect(store.getPracticeSettings()).toMatchObject({ revision: 4, epoch: 0 });

    await store.resetPractice();
    expect(store.getPracticeSettings()).toEqual({
      ...DEFAULT_PRACTICE_SETTINGS,
      revision: 5,
      epoch: 1,
    });
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects stale and expired snooze operations without replacement", async () => {
    const store = await FluencyStore.open(root);
    await store.setPracticeEnabled(true);
    const path = join(root, "practice.json");
    const before = await readFile(path, "utf8");

    await expect(store.snoozePracticeForFiveHours(0, Date.now() + 1_000)).resolves.toBe(false);
    await expect(store.snoozePracticeForFiveHours(1, Date.now() - 1)).resolves.toBe(false);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(store.getPracticeSettings().revision).toBe(1);
    expect(store.getPracticeSettings()).not.toHaveProperty("snoozedUntil");
  });

  it("keeps history clear and practice Reset independent", async () => {
    const store = await FluencyStore.open(root);
    await store.recordPracticeConsent(10);
    await store.setPracticeTarget(target("Rule", "rule.key"), true);
    await store.clear();
    expect(store.getPracticeSettings()).toMatchObject({ consentedAt: 10, targets: [target("Rule", "rule.key")] });

    await store.resetPractice();
    expect(store.getPracticeSettings()).toEqual({ ...DEFAULT_PRACTICE_SETTINGS, revision: 3, epoch: 1 });
    expect(store.getSettings().consentedAt).toBeUndefined();
  });
});

describe("conversation-session practice snooze", () => {
  it("survives same-file reload, rejects copied fork, and is invalidated only by epoch", () => {
    const state = new PracticeSessionSnooze();
    const entries: Array<{ type: string; customType: string; data: unknown }> = [];
    state.snooze("/sessions/original.jsonl", 4, (customType, data) => {
      entries.push({ type: "custom", customType, data });
    });

    expect(entries[0]).toMatchObject({
      customType: PRACTICE_SESSION_ENTRY_TYPE,
      data: { epoch: 4, sessionHash: hashPracticeSessionFile("/sessions/original.jsonl") },
    });
    expect(JSON.stringify(entries)).not.toContain("/sessions/original.jsonl");
    expect(new PracticeSessionSnooze().restore(entries, "/sessions/original.jsonl", 4)).toBe(true);
    expect(new PracticeSessionSnooze().restore(entries, "/sessions/fork.jsonl", 4)).toBe(false);
    expect(new PracticeSessionSnooze().restore(entries, "/sessions/original.jsonl", 5)).toBe(false);
    expect(new PracticeSessionSnooze().restore(entries, "/sessions/original.jsonl", 4)).toBe(true);
  });

  it("durably resumes same-file snooze using latest applicable session entry", () => {
    const sessionFile = "/sessions/original.jsonl";
    const entries: Array<{ type: string; customType: string; data: unknown }> = [];
    const appendEntry = (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    };
    const state = new PracticeSessionSnooze();

    state.snooze(sessionFile, 4, appendEntry);
    state.resume(sessionFile, 4, appendEntry);

    expect(entries.at(-1)).toMatchObject({
      customType: PRACTICE_SESSION_RESUME_ENTRY_TYPE,
      data: { epoch: 4, sessionHash: hashPracticeSessionFile(sessionFile) },
    });
    expect(new PracticeSessionSnooze().restore(entries, sessionFile, 4)).toBe(false);
    expect(new PracticeSessionSnooze().restore(entries, "/sessions/fork.jsonl", 4)).toBe(false);

    state.snooze(sessionFile, 4, appendEntry);
    expect(new PracticeSessionSnooze().restore(entries, sessionFile, 4)).toBe(true);
    expect(new PracticeSessionSnooze().restore(entries, sessionFile, 5)).toBe(false);
  });

  it("uses runtime-only state for ephemeral sessions", () => {
    const state = new PracticeSessionSnooze();
    let appended = false;
    const appendEntry = () => { appended = true; };
    state.snooze(undefined, 2, appendEntry);
    expect(appended).toBe(false);
    expect(state.restore([], undefined, 2)).toBe(true);
    expect(state.restore([], undefined, 3)).toBe(false);
    state.resume(undefined, 2, appendEntry);
    expect(state.restore([], undefined, 2)).toBe(false);
    expect(appended).toBe(false);
  });
});
