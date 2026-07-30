import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  FluencyOverlay,
  type IgnoreTarget,
  showFluencyOverlay,
} from "../extensions/pi-fluency/overlay.js";
import type { FluencyStore } from "../extensions/pi-fluency/store.js";
import type { ReviewPattern } from "../extensions/pi-fluency/types.js";
import {
  makeOverlay,
  pattern,
  plain,
} from "./helpers/overlay-fixtures.js";

describe("FluencyOverlay actions", () => {
  it("keeps every mutation key inert in read-only Stats", async () => {
    const fixture = makeOverlay({ initialView: "stats" });
    for (const key of ["a", "l", "d", "i", "u"]) await fixture.overlay.handleInput(key);
    expect(fixture.actions).toEqual([]);
  });

  it("cycles Inbox, Accepted, Ignored, and Stats and supports direct initial Stats", async () => {
    const fixture = makeOverlay();
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    expect(plain(fixture.overlay.render(80)).join("\n")).toContain("Pi Fluency · Stats");
    await fixture.overlay.handleInput("\t");
    expect(plain(fixture.overlay.render(80)).join("\n")).toContain("Pi Fluency · Inbox");
    expect(fixture.actions.filter((action) => action.startsWith("view:"))).toEqual([
      "view:accepted", "view:ignored", "view:stats", "view:inbox",
    ]);
  });

  it("clamps horizontal carousel navigation at both ends", async () => {
    const fixture = makeOverlay();
    await fixture.overlay.handleInput("\u001b[D");
    expect(plain(fixture.overlay.render(80)).join("\n")).toContain("← 1 / 2 →");
    await fixture.overlay.handleInput("\u001b[C");
    await fixture.overlay.handleInput("\u001b[C");
    expect(plain(fixture.overlay.render(80)).join("\n")).toContain("← 2 / 2 →");
    await fixture.overlay.handleInput("\u001b[D");
    expect(plain(fixture.overlay.render(80)).join("\n")).toContain("← 1 / 2 →");
  });

  it.each([
    { view: "inbox", action: "l" },
    { view: "inbox", action: "d" },
    { view: "inbox", action: "i" },
    { view: "accepted", action: "i" },
    { view: "ignored", action: "u" },
  ] as const)("keeps the same slot and falls back after $action removes a card in $view", async ({ view, action }) => {
    const cardOverrides = view === "accepted"
      ? { pendingCount: 0, acceptedCount: 3 }
      : {};
    const ignoredPatternKeys = view === "ignored"
      ? ["grammar.articles.first", "grammar.articles.second", "grammar.articles.third"]
      : [];
    const switchToView = async (overlay: FluencyOverlay): Promise<void> => {
      const tabs = view === "inbox" ? 0 : view === "accepted" ? 1 : 2;
      for (let index = 0; index < tabs; index += 1) await overlay.handleInput("\t");
    };

    const middle = makeOverlay({
      patterns: [pattern("first", cardOverrides), pattern("second", cardOverrides), pattern("third", cardOverrides)],
      ignoredPatternKeys,
    });
    await switchToView(middle.overlay);
    await middle.overlay.handleInput("\u001b[C");
    await middle.overlay.handleInput(action);
    const advanced = plain(middle.overlay.render(80)).join("\n");
    expect(advanced).toContain("third");
    expect(advanced).toContain("← 2 / 2 →");

    const last = makeOverlay({
      patterns: [pattern("first", cardOverrides), pattern("second", cardOverrides)],
      ignoredPatternKeys,
    });
    await switchToView(last.overlay);
    await last.overlay.handleInput("\u001b[C");
    await last.overlay.handleInput(action);
    const previous = plain(last.overlay.render(80)).join("\n");
    expect(previous).toContain("first");
    expect(previous).toContain("← 1 / 1 →");
  });

  it("resets carousel index and card scroll when changing views", async () => {
    const patterns = [
      pattern("first", { explanation: "first page ".repeat(100) }),
      pattern("second"),
      pattern("accepted", { pendingCount: 0, acceptedCount: 3, explanation: "accepted page ".repeat(100) }),
    ];
    const fixture = makeOverlay({ patterns, rows: 20 });
    await fixture.overlay.handleInput("\u001b[C");
    fixture.overlay.render(48);
    await fixture.overlay.handleInput("j");
    await fixture.overlay.handleInput("\t");

    const switched = plain(fixture.overlay.render(48));
    const fresh = makeOverlay({ patterns, rows: 20 }).overlay;
    await fresh.handleInput("\t");
    expect(switched).toEqual(plain(fresh.render(48)));
    expect(switched.slice(0, 3).join(" ")).toContain("Pending 0 · accepted 3 · ← 1 /");
  });

  it("uses explanation and human ERRANT category in ignore choices", async () => {
    const selectIgnore = vi.fn(async (_title: string, options: string[]) => options[1]);
    const item = pattern("private-key", { errorType: "R:PUNCT", explanation: "Capitalize the first word of a sentence" });
    const fixture = makeOverlay({ patterns: [item], overrides: { selectIgnore } });

    await fixture.overlay.handleInput("i");

    const [title, options] = selectIgnore.mock.calls[0]!;
    expect(title).toBe("Ignore fluency pattern");
    expect(options).toEqual([
      "Ignore only: Capitalize the first word of a sentence",
      "Ignore this kind of mistake: Punctuation",
      "Cancel",
    ]);
    expect(`${title} ${options.join(" ")}`).not.toContain(item.patternKey);
    expect(`${title} ${options.join(" ")}`).not.toContain("R:PUNCT");
    expect(fixture.actions).toEqual(["ignore-category:PUNCT"]);
  });

  it.each(["accept", "dismiss"] as const)("shows recurrence arriving after %s while overlay remains open", async (decision) => {
    const item = pattern("recurrence", { pendingCount: 2, acceptedCount: 0, dismissedCount: 0 });
    const fixture = makeOverlay({
      patterns: [item],
      overrides: {
        accept: async () => {
          item.acceptedCount += item.pendingCount;
          item.pendingCount = 0;
        },
        dismiss: async () => {
          item.dismissedCount += item.pendingCount;
          item.pendingCount = 0;
        },
      },
    });
    await fixture.overlay.handleInput(decision === "accept" ? "a" : "d");
    item.pendingCount = 1;

    const inbox = plain(fixture.overlay.render(80)).join("\n");
    expect(inbox).toContain("Pending 1");
    expect(inbox).toContain("recurrence");
    if (decision === "accept") {
      await fixture.overlay.handleInput("\t");
      expect(plain(fixture.overlay.render(80)).join("\n")).toContain("Pending 1 · accepted 2");
    }
  });

  it("moves the accepted batch into Accepted view with updated review counts", async () => {
    const fixture = makeOverlay({ patterns: [pattern("batch", { pendingCount: 4, acceptedCount: 2 })] });
    await fixture.overlay.handleInput("a");
    await fixture.overlay.handleInput("\t");

    expect(plain(fixture.overlay.render(80)).join("\n")).toContain("Pending 0 · accepted 6");
    expect(fixture.actions).toContain("accept:batch");
  });

  it("does not offer or execute accept in Accepted view", async () => {
    const fixture = makeOverlay({ patterns: [pattern("accepted", { pendingCount: 0, acceptedCount: 3 })] });
    await fixture.overlay.handleInput("\t");

    const before = plain(fixture.overlay.render(80));
    expect(before.join("\n")).not.toContain("a accept");
    expect(before.at(-1)).toBe(" i ignore  tab view  esc close");
    await fixture.overlay.handleInput("l");

    expect(fixture.actions).toEqual(["view:accepted"]);
    expect(plain(fixture.overlay.render(80))).toEqual(before);
  });

  it("navigates, accepts, ignores, switches view, unignores, and closes", async () => {
    const fixture = makeOverlay();
    await fixture.overlay.handleInput("\u001b[C");
    await fixture.overlay.handleInput("l");
    await fixture.overlay.handleInput("i");
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("u");
    await fixture.overlay.handleInput("\u001b");
    expect(fixture.actions).toEqual([
      "accept:second",
      "ignore-rule:first",
      "view:accepted",
      "view:ignored",
      "restore:first:pattern:grammar.articles.first",
      "close",
    ]);
    expect(fixture.tui.requestRender).toHaveBeenCalled();
  });

  it("supports dismiss and disposal", async () => {
    const fixture = makeOverlay();
    await fixture.overlay.handleInput("\u001b[C");
    await fixture.overlay.handleInput("d");
    fixture.overlay.dispose();
    await fixture.overlay.handleInput("\u001b");
    expect(fixture.actions).toEqual(["dismiss:second"]);
  });

  it("resets card paging after successful ignore and unignore", async () => {
    const long = { explanation: "long selected detail ".repeat(80) };
    const ignored = makeOverlay({ patterns: [pattern("first", long), pattern("second", long)], rows: 20 });
    ignored.overlay.render(48);
    await ignored.overlay.handleInput("\u001b[6~");
    await ignored.overlay.handleInput("i");
    const afterIgnore = plain(ignored.overlay.render(48));
    expect(afterIgnore.some((line) => line.includes("› I want to have an second"))).toBe(true);

    const unignored = makeOverlay({
      patterns: [pattern("first", long), pattern("second", long)],
      rows: 20,
      ignoredPatternKeys: ["grammar.articles.first", "grammar.articles.second"],
    });
    await unignored.overlay.handleInput("\t");
    await unignored.overlay.handleInput("\t");
    unignored.overlay.render(48);
    await unignored.overlay.handleInput("\u001b[6~");
    await unignored.overlay.handleInput("u");
    const afterUnignore = plain(unignored.overlay.render(48));
    expect(afterUnignore.some((line) => line.includes("› I want to have an second"))).toBe(true);
  });

  it("rerenders ignore, restore, and re-ignore from authoritative callback state", async () => {
    const fixture = makeOverlay({ patterns: [pattern("first"), pattern("second")] });

    await fixture.overlay.handleInput("i");
    expect(fixture.ignoredPatternKeys).toEqual(new Set(["grammar.articles.first"]));
    expect(plain(fixture.overlay.render(80)).join("\n")).toContain("second");

    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    expect(plain(fixture.overlay.render(80)).join("\n")).toContain("first");
    await fixture.overlay.handleInput("u");
    expect(fixture.ignoredPatternKeys.size).toBe(0);
    expect(plain(fixture.overlay.render(80))).toContain(" No ignored patterns.");

    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("i");
    expect(fixture.ignoredPatternKeys).toEqual(new Set(["grammar.articles.first"]));
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    expect(plain(fixture.overlay.render(80)).join("\n")).toContain("first");
  });

  it("clears a restored category override from every matching card in the open overlay", async () => {
    const categories = new Set<string>();
    const patterns = [pattern("first"), pattern("second")];
    const fixture = makeOverlay({
      patterns,
      overrides: {
        ignoredBy: (item) => categories.has("DET")
          ? [{ kind: "category" as const, value: "DET" as const }]
          : [],
        selectIgnore: async (_title, choices) => choices[1],
        ignoreCategory: async (category) => { categories.add(category); },
        restoreIgnored: async () => { categories.clear(); },
      },
    });

    await fixture.overlay.handleInput("i");
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\u001b[C");
    await fixture.overlay.handleInput("u");
    expect(plain(fixture.overlay.render(80))).toContain(" No ignored patterns.");

    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    expect(plain(fixture.overlay.render(80)).join("\n")).toContain("← 1 / 2 →");
  });

  it("passes every deduplicated restore target to one atomic callback and advances", async () => {
    const targets = [
      { kind: "pattern" as const, value: "grammar.articles.first" },
      { kind: "category" as const, value: "DET" as const },
      { kind: "pattern" as const, value: "grammar.articles.first" },
      { kind: "category" as const, value: "OTHER" as const },
      { kind: "category" as const, value: "DET" as const },
    ];
    const authoritative = new Map<string, IgnoreTarget[]>([
      ["first", targets],
      ["second", [{ kind: "pattern", value: "grammar.articles.second" }]],
    ]);
    const restoreIgnored = vi.fn(async (_targets: IgnoreTarget[], item: ReviewPattern) => {
      authoritative.delete(item.id);
    });
    const fixture = makeOverlay({
      patterns: [pattern("first"), pattern("second")],
      overrides: {
        ignoredBy: (item) => authoritative.get(item.id) ?? [],
        restoreIgnored,
      },
    });
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("u");

    expect(restoreIgnored).toHaveBeenCalledOnce();
    expect(restoreIgnored).toHaveBeenCalledWith([
      { kind: "pattern", value: "grammar.articles.first" },
      { kind: "category", value: "DET" },
      { kind: "category", value: "OTHER" },
    ], expect.objectContaining({ id: "first" }));
    const after = plain(fixture.overlay.render(80)).join("\n");
    expect(after).toContain("second");
    expect(after).toContain("← 1 / 1 →");
    expect(after).not.toContain("first");
  });

  it("keeps ignore overrides unchanged when the atomic restore callback fails", async () => {
    const restoreIgnored = vi.fn(async () => { throw new Error("restore transaction failed"); });
    const fixture = makeOverlay({
      patterns: [pattern("first")],
      overrides: {
        ignoredBy: (item) => [
          { kind: "pattern", value: item.patternKey },
          { kind: "category", value: "DET" },
        ],
        restoreIgnored,
      },
    });
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("u");

    expect(restoreIgnored).toHaveBeenCalledOnce();
    const after = plain(fixture.overlay.render(80)).join("\n");
    expect(after).toContain("first");
    expect(after).toContain("Action failed: restore transaction failed");
  });

  it("keeps failed state and ignore actions visible with a sanitized persistent error", async () => {
    const state = makeOverlay({ overrides: { accept: async () => { throw new Error("accept\u001b[31m failed\nretry"); } } });
    await state.overlay.handleInput("l");
    const stateLines = plain(state.overlay.render(60));
    expect(stateLines.some((line) => line.includes("› I want to have an first"))).toBe(true);
    expect(stateLines.some((line) => line.includes("Action failed: accept?[31m failed?retry"))).toBe(true);
    expect(plain(state.overlay.render(60))).toEqual(stateLines);

    const ignored = makeOverlay({ overrides: { ignorePattern: async () => { throw new Error("ignore failed"); } } });
    await ignored.overlay.handleInput("i");
    expect(plain(ignored.overlay.render(60)).some((line) => line.includes("Action failed: ignore failed"))).toBe(true);
    await ignored.overlay.handleInput("\t");
    await ignored.overlay.handleInput("\t");
    expect(plain(ignored.overlay.render(60))).toContain(" No ignored patterns.");
  });

  it("keeps failed unignore in ignored view", async () => {
    const exact = { kind: "pattern" as const, value: "grammar.articles.first" };
    const fixture = makeOverlay({
      patterns: [pattern("first")],
      overrides: {
        ignoredBy: () => [exact],
        restoreIgnored: async () => { throw new Error("restore failed"); },
      },
    });
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("\t");
    await fixture.overlay.handleInput("u");
    const lines = plain(fixture.overlay.render(60));
    expect(lines.some((line) => line.includes("› I want to have an first"))).toBe(true);
    expect(lines.some((line) => line.includes("Action failed: restore failed"))).toBe(true);
  });

  it("requests render after async action success", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const item = pattern("first");
    const fixture = makeOverlay({
      patterns: [item],
      overrides: {
        accept: async () => {
          await pending;
          item.acceptedCount += item.pendingCount;
          item.pendingCount = 0;
        },
      },
    });
    const input = fixture.overlay.handleInput("l");
    const rendersWhilePending = fixture.tui.requestRender.mock.calls.length;
    finish();
    await input;
    expect(fixture.tui.requestRender.mock.calls.length).toBeGreaterThan(rendersWhilePending);
    expect(plain(fixture.overlay.render(60)).some((line) => line.includes("I want to have an first"))).toBe(false);
  });

  it("ignores late async completion after disposal", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const fixture = makeOverlay({ overrides: { accept: () => pending } });
    const input = fixture.overlay.handleInput("l");
    fixture.overlay.dispose();
    const rendersBeforeCompletion = fixture.tui.requestRender.mock.calls.length;
    finish();
    await input;
    expect(fixture.tui.requestRender).toHaveBeenCalledTimes(rendersBeforeCompletion);
    expect(fixture.overlay.render(60)).toEqual([]);
  });

  it.each([
    { name: "accept", input: "a", select: undefined, ignored: false, method: "acceptPattern" },
    { name: "dismiss", input: "d", select: undefined, ignored: false, method: "dismissPattern" },
    { name: "ignore exact", input: "i", select: "Ignore only: Use “a” before a consonant sound. This explanation can wrap safely.", ignored: false, method: "ignorePatternKey" },
    { name: "ignore category", input: "i", select: "Ignore this kind of mistake: Determiner", ignored: false, method: "ignoreCategory" },
    { name: "atomic restore", input: "u", select: undefined, ignored: true, method: "restoreIgnoreTargets" },
  ] as const)("publishes progress only after successful $name persistence", async ({ input, select, ignored, method }) => {
    let persisted = false;
    const onProgressChanged = vi.fn(() => { expect(persisted).toBe(true); });
    const mutation = vi.fn(async () => { persisted = true; });
    const item = pattern("progress");
    const store = {
      listReviewPatterns: () => [item],
      getSettings: () => ({
        ignoredPatternKeys: ignored ? [item.patternKey] : [],
        ignoredCategories: [],
      }),
      acceptPattern: method === "acceptPattern" ? mutation : vi.fn(),
      dismissPattern: method === "dismissPattern" ? mutation : vi.fn(),
      ignorePatternKey: method === "ignorePatternKey" ? mutation : vi.fn(),
      ignoreCategory: method === "ignoreCategory" ? mutation : vi.fn(),
      restoreIgnoreTargets: method === "restoreIgnoreTargets" ? mutation : vi.fn(),
    } as unknown as FluencyStore;
    const custom = vi.fn(async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
      let done!: () => void;
      const closed = new Promise<void>((resolve) => { done = resolve; });
      const component = factory(
        { requestRender: vi.fn() } as never,
        { fg: (_color: string, text: string) => text } as never,
        { matches: () => false } as never,
        done,
      ) as FluencyOverlay;
      if (ignored) {
        await component.handleInput("\t");
        await component.handleInput("\t");
      }
      await component.handleInput(input);
      done();
      await closed;
    });
    const ctx = {
      mode: "tui",
      ui: { custom, select: vi.fn(async () => select), notify: vi.fn() },
    } as unknown as ExtensionContext;

    await showFluencyOverlay(ctx, store, undefined, onProgressChanged);
    expect(mutation).toHaveBeenCalledOnce();
    expect(onProgressChanged).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "accept", input: "a", select: undefined, ignored: false, method: "acceptPattern" },
    { name: "dismiss", input: "d", select: undefined, ignored: false, method: "dismissPattern" },
    { name: "ignore exact", input: "i", select: "Ignore only: Use “a” before a consonant sound. This explanation can wrap safely.", ignored: false, method: "ignorePatternKey" },
    { name: "ignore category", input: "i", select: "Ignore this kind of mistake: Determiner", ignored: false, method: "ignoreCategory" },
    { name: "atomic restore", input: "u", select: undefined, ignored: true, method: "restoreIgnoreTargets" },
  ] as const)("publishes mutation errors without progress when $name persistence fails", async ({ input, select, ignored, method }) => {
    const onProgressChanged = vi.fn();
    const onMutationError = vi.fn();
    const failure = new Error("write failed");
    const mutation = vi.fn(async () => { throw failure; });
    const item = pattern("failed-progress");
    const store = {
      listReviewPatterns: () => [item],
      getSettings: () => ({
        ignoredPatternKeys: ignored ? [item.patternKey] : [],
        ignoredCategories: [],
      }),
      acceptPattern: method === "acceptPattern" ? mutation : vi.fn(),
      dismissPattern: method === "dismissPattern" ? mutation : vi.fn(),
      ignorePatternKey: method === "ignorePatternKey" ? mutation : vi.fn(),
      ignoreCategory: method === "ignoreCategory" ? mutation : vi.fn(),
      restoreIgnoreTargets: method === "restoreIgnoreTargets" ? mutation : vi.fn(),
    } as unknown as FluencyStore;
    const custom = vi.fn(async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
      let done!: () => void;
      const closed = new Promise<void>((resolve) => { done = resolve; });
      const component = factory(
        { requestRender: vi.fn() } as never,
        { fg: (_color: string, text: string) => text } as never,
        { matches: () => false } as never,
        done,
      ) as FluencyOverlay;
      if (ignored) {
        await component.handleInput("\t");
        await component.handleInput("\t");
      }
      await component.handleInput(input);
      done();
      await closed;
    });
    const ctx = {
      mode: "tui",
      ui: { custom, select: vi.fn(async () => select), notify: vi.fn() },
    } as unknown as ExtensionContext;

    await showFluencyOverlay(ctx, store, undefined, onProgressChanged, onMutationError);
    expect(mutation).toHaveBeenCalledOnce();
    expect(onProgressChanged).not.toHaveBeenCalled();
    expect(onMutationError).toHaveBeenCalledOnce();
    expect(onMutationError).toHaveBeenCalledWith(failure);
  });

  it("keeps callback failures from escaping the overlay mutation failure path", async () => {
    const failure = new Error("write failed");
    const fixture = makeOverlay({
      overrides: {
        accept: async () => { throw failure; },
        mutationError: () => { throw new Error("status callback failed"); },
      },
    });

    await expect(fixture.overlay.handleInput("l")).resolves.toBeUndefined();
    expect(plain(fixture.overlay.render(60)).join("\n")).toContain("Action failed: write failed");
  });

  it("closes and disposes on abort and preserves the custom overlay options contract", async () => {
    let component: FluencyOverlay | undefined;
    let options!: NonNullable<Parameters<ExtensionContext["ui"]["custom"]>[1]>;
    const custom = vi.fn((
      factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
      customOptions: Parameters<ExtensionContext["ui"]["custom"]>[1],
    ) => {
      options = customOptions!;
      return new Promise<void>((resolve) => {
        component = factory(
          { requestRender: vi.fn() } as never,
          { fg: (_color: string, text: string) => text } as never,
          { matches: () => false } as never,
          () => resolve(),
        ) as FluencyOverlay;
      });
    });
    const ctx = {
      mode: "tui",
      ui: { custom, select: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const controller = new AbortController();
    const opening = showFluencyOverlay(ctx, {} as FluencyStore, controller.signal);
    await vi.waitFor(() => expect(component).toBeDefined());

    controller.abort();
    await opening;
    expect(component?.render(60)).toEqual([]);
    expect(custom).toHaveBeenCalledOnce();
    expect(options.overlayOptions).toMatchObject({
      anchor: "center",
      width: "75%",
      minWidth: 56,
      maxHeight: "80%",
    });
  });
});
