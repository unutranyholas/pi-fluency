import { describe, expect, it, vi } from "vitest";
import { CoachingOverlay, showCoachingOverlay } from "../extensions/pi-fluency/coaching-overlay.js";
import type { AnalyzerMistake, PracticeTarget } from "../extensions/pi-fluency/types.js";

const mistake = (key: string, label: string): AnalyzerMistake => ({
  original: `bad ${label}`,
  correction: `good ${label}`,
  sourceExcerpt: `Original ${label}`,
  correctedExcerpt: `Suggestion ${label}`,
  contextScope: "sentence",
  explanation: `Why ${label}`,
  errorType: "R:DET",
  patternKey: key,
  confidence: 0.99,
});

const keybindings = {
  matches: (data: string, binding: string) => ({
    "tui.select.up": "up",
    "tui.select.down": "down",
    "tui.select.confirm": "enter",
    "tui.select.cancel": "esc",
    "tui.select.pageUp": "page-up",
    "tui.select.pageDown": "page-down",
  }[binding] === data),
};

function plain(lines: string[]): string {
  return lines.map((line) => line.replace(/^./, "").replace(/.$/, "").trimEnd()).join("\n");
}

describe("CoachingOverlay", () => {
  it("starts on Edit and exposes checking escape hatches", () => {
    const finish = vi.fn();
    const overlay = new CoachingOverlay({
      tui: { requestRender: vi.fn(), terminal: { rows: 30 } },
      keybindings,
      finish,
    });
    expect(plain(overlay.render(80))).toContain("Checking selected fluency rules…");
    overlay.handleInput("s");
    expect(finish).toHaveBeenCalledWith("send-unchecked");
  });

  it("renders bounded, ordered explicit details and keyboard actions", () => {
    const finish = vi.fn();
    const overlay = new CoachingOverlay({
      tui: { requestRender: vi.fn(), terminal: { rows: 30 } },
      keybindings,
      finish,
    });
    const targets: PracticeTarget[] = [
      { explanation: "Second selected", memberPatternKeys: ["second"] },
      { explanation: "First selected", memberPatternKeys: ["first"] },
      { explanation: "Third selected", memberPatternKeys: ["third"] },
      { explanation: "Fourth selected", memberPatternKeys: ["fourth"] },
    ];
    overlay.setMatches([
      mistake("first", "source-first"),
      mistake("second", "source-second"),
      mistake("third", "source-third"),
      mistake("fourth", "source-fourth"),
    ], targets);
    const rendered = plain(overlay.render(100));
    expect(rendered).toContain("4 matches · +1 more");
    expect(rendered.indexOf("Original source-second")).toBeLessThan(rendered.indexOf("Original source-first"));
    expect(rendered).toContain("Original:");
    expect(rendered).toContain("Suggestion:");
    expect(rendered).toContain("Why:");
    expect(rendered).toContain("› Edit");

    overlay.handleInput("down");
    overlay.handleInput("enter");
    expect(finish).toHaveBeenCalledWith("send-once");
  });

  it("paginates matches within one rule and pins actions at short height", () => {
    const overlay = new CoachingOverlay({
      tui: { requestRender: vi.fn(), terminal: { rows: 15 } },
      keybindings,
      finish: vi.fn(),
    });
    overlay.setMatches(
      Array.from({ length: 5 }, (_, index) => mistake("same", `match-${index + 1}`)),
      [{ explanation: "One busy rule", memberPatternKeys: ["same"] }],
    );

    const firstLines = overlay.render(80);
    const first = plain(firstLines);
    expect(firstLines).toHaveLength(15);
    expect(first).toContain("5 matches · +4 more");
    expect(first).toContain("Original: Original match-1");
    expect(first).toContain("Why: Why match-1");
    expect(first).toContain("› Edit");
    expect(first).toContain("5 Snooze 5 hours");

    overlay.handleInput("page-down");
    const second = plain(overlay.render(80));
    expect(second).toContain("Original: Original match-2");
    expect(second).not.toContain("Original: Original match-1");
    overlay.handleInput("page-up");
    expect(plain(overlay.render(80))).toContain("Original: Original match-1");
  });

  it("reserves snooze before persistence so abort cannot choose unchecked send", async () => {
    let component!: CoachingOverlay;
    let finishCustom!: () => void;
    let resolveSave!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const controller = new AbortController();
    const ctx = {
      mode: "tui",
      ui: {
        custom: vi.fn((factory: Function) => new Promise<void>((resolve) => {
          finishCustom = resolve;
          component = factory(
            { requestRender: vi.fn(), terminal: { rows: 30 } },
            undefined,
            keybindings,
            resolve,
          );
        })),
      },
    } as never;
    const shown = showCoachingOverlay(ctx, Promise.resolve({
      kind: "matches" as const,
      mistakes: [mistake("first", "one")],
      targets: [{ explanation: "Rule", memberPatternKeys: ["first"] }],
    }), controller.signal, save);
    await vi.waitFor(() => expect(component).toBeDefined());
    await vi.waitFor(() => expect(plain(component.render(80))).toContain("Practice check"));

    component.handleInput("5");
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith("snooze-five-hours"));
    controller.abort();
    expect(plain(component.render(80))).toContain("Saving snooze…");
    resolveSave();
    await expect(shown).resolves.toBe("snooze-five-hours");
    finishCustom();
  });

  it("freezes every action while snooze save is pending", () => {
    const finish = vi.fn();
    const overlay = new CoachingOverlay({
      tui: { requestRender: vi.fn(), terminal: { rows: 30 } },
      keybindings,
      finish,
    });
    overlay.setMatches([mistake("first", "one")], [{ explanation: "Rule", memberPatternKeys: ["first"] }]);
    overlay.setSaving(true);
    for (const key of ["s", "e", "t", "5", "esc", "enter", "down"]) overlay.handleInput(key);
    expect(finish).not.toHaveBeenCalled();
    expect(plain(overlay.render(80))).toContain("Saving snooze…");
  });
});
