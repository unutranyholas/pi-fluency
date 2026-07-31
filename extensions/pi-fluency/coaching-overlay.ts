import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalLabel } from "./sanitize.js";
import type { AnalyzerMistake, PracticeTarget } from "./types.js";

export type CoachingOverlayDecision =
  | "edit"
  | "send-unchecked"
  | "send-once"
  | "snooze-session"
  | "snooze-five-hours"
  | "clean"
  | "technical-failure";

export type CoachingCheckResult =
  | { kind: "matches"; mistakes: AnalyzerMistake[]; targets: PracticeTarget[] }
  | { kind: "clean" }
  | { kind: "failure" };

export type CoachingSnoozeDecision = "snooze-session" | "snooze-five-hours";
export type CoachingSnoozeHandler = (decision: CoachingSnoozeDecision) => Promise<void>;

interface CoachingOverlayOptions {
  tui: { requestRender(): void; terminal: { rows: number } };
  theme?: Theme;
  keybindings?: { matches(data: string, binding: string): boolean };
  finish: (decision: CoachingOverlayDecision) => void;
  saveSnooze?: CoachingSnoozeHandler;
}

type Mode = "checking" | "matched" | "saving";
const ACTIONS = ["Edit", "Send once", "Snooze session", "Snooze 5 hours"] as const;

function safe(value: string, maximum = 500): string {
  return sanitizeTerminalLabel(value, maximum) || "—";
}

/** Keyboard-first submit checkpoint. Contains validated analysis only, never received draft text. */
export class CoachingOverlay implements Component {
  private mode: Mode = "checking";
  private mistakes: AnalyzerMistake[] = [];
  private targets: PracticeTarget[] = [];
  private selectedAction = 0;
  private detailOffset = 0;
  private disposed = false;

  constructor(private readonly options: CoachingOverlayOptions) {}

  setMatches(mistakes: AnalyzerMistake[], targets: PracticeTarget[]): void {
    if (this.disposed) return;
    this.mode = "matched";
    this.mistakes = [...mistakes];
    this.targets = targets.map((target) => ({ ...target, memberPatternKeys: [...target.memberPatternKeys] }));
    this.options.tui.requestRender();
  }

  setSaving(saving: boolean): void {
    if (this.disposed) return;
    this.mode = saving ? "saving" : "matched";
    this.options.tui.requestRender();
  }

  invalidate(): void { /* No cached layout. */ }
  dispose(): void { this.disposed = true; }

  private matches(data: string, binding: string): boolean {
    return this.options.keybindings?.matches(data, binding) ?? false;
  }

  handleInput(data: string): void {
    if (this.disposed || this.mode === "saving") return;
    const cancel = data === Key.escape || this.matches(data, "tui.select.cancel");
    if (this.mode === "checking") {
      if (cancel) this.options.finish("edit");
      else if (data.toLowerCase() === "s") this.options.finish("send-unchecked");
      return;
    }
    if (cancel || data.toLowerCase() === "e") {
      this.options.finish("edit");
      return;
    }
    if (data.toLowerCase() === "s") this.options.finish("send-once");
    else if (data.toLowerCase() === "t") this.beginSnooze("snooze-session");
    else if (data === "5") this.beginSnooze("snooze-five-hours");
    else if (data === "j" || this.matches(data, "tui.select.down")) {
      this.selectedAction = Math.min(ACTIONS.length - 1, this.selectedAction + 1);
      this.options.tui.requestRender();
    } else if (data === "k" || this.matches(data, "tui.select.up")) {
      this.selectedAction = Math.max(0, this.selectedAction - 1);
      this.options.tui.requestRender();
    } else if (this.matches(data, "tui.select.pageDown")) {
      this.detailOffset = Math.min(Math.max(0, this.mistakeGroups().length - 1), this.detailOffset + 1);
      this.options.tui.requestRender();
    } else if (this.matches(data, "tui.select.pageUp")) {
      this.detailOffset = Math.max(0, this.detailOffset - 1);
      this.options.tui.requestRender();
    } else if (data === Key.enter || this.matches(data, "tui.select.confirm")) {
      const action = (["edit", "send-once", "snooze-session", "snooze-five-hours"] as const)[this.selectedAction]!;
      if (action === "snooze-session" || action === "snooze-five-hours") this.beginSnooze(action);
      else this.options.finish(action);
    }
  }

  private beginSnooze(action: CoachingSnoozeDecision): void {
    if (!this.options.saveSnooze) {
      this.options.finish(action);
      return;
    }
    this.setSaving(true);
    void this.options.saveSnooze(action).then(
      () => this.options.finish(action),
      () => this.setSaving(false),
    );
  }

  private mistakeGroups(): Array<{ label: string; mistakes: AnalyzerMistake[] }> {
    const groups = this.targets.map((target) => ({
      label: target.explanation,
      mistakes: this.mistakes.filter((mistake) => target.memberPatternKeys.includes(mistake.patternKey)),
    })).filter((group) => group.mistakes.length > 0);
    const selectedKeys = new Set(this.targets.flatMap((target) => target.memberPatternKeys));
    for (const mistake of this.mistakes) {
      if (!selectedKeys.has(mistake.patternKey)) groups.push({ label: mistake.explanation, mistakes: [mistake] });
    }
    return groups;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(40, Math.min(width - 2, 88));
    const border = (text: string): string => this.options.theme?.fg("border", text) ?? text;
    const lines: string[] = [];
    if (this.mode === "checking") {
      lines.push(" Checking selected fluency rules…", "", " s Send unchecked   esc Edit");
    } else {
      const groups = this.mistakeGroups();
      const visible = groups.slice(this.detailOffset, this.detailOffset + 3);
      const hidden = groups.slice(this.detailOffset + visible.length)
        .reduce((total, group) => total + group.mistakes.length, 0);
      lines.push(` Practice check · ${this.mistakes.length} ${this.mistakes.length === 1 ? "match" : "matches"}${hidden > 0 ? ` · +${hidden} more` : ""}`);
      for (const group of visible) {
        lines.push(" ────────────────────────────────────────", ` Rule: ${safe(group.label)}`);
        for (const mistake of group.mistakes) {
          for (const [label, value] of [
            ["Original", mistake.sourceExcerpt],
            ["Suggestion", mistake.correctedExcerpt],
            ["Why", mistake.explanation],
          ] as const) {
            const wrapped = wrapTextWithAnsi(`${label}: ${safe(value)}`, Math.max(10, contentWidth - 2));
            lines.push(...wrapped.map((line) => ` ${line}`));
          }
        }
      }
      if (groups.length > 3) lines.push(` PageUp/PageDown details · ${this.detailOffset + 1}-${this.detailOffset + visible.length} of ${groups.length} rules`);
      lines.push(" ────────────────────────────────────────");
      if (this.mode === "saving") lines.push(" Saving snooze…");
      else {
        for (let index = 0; index < ACTIONS.length; index += 1) {
          lines.push(` ${index === this.selectedAction ? "›" : " "} ${ACTIONS[index]}`);
        }
        lines.push(" e Edit  s Send once  t Snooze session  5 Snooze 5 hours  esc Edit");
      }
    }
    const top = border(`╭${"─".repeat(contentWidth)}╮`);
    const bottom = border(`╰${"─".repeat(contentWidth)}╯`);
    return [top, ...lines.map((line) => {
      const content = truncateToWidth(line, contentWidth, "");
      return `${border("│")}${content}${" ".repeat(Math.max(0, contentWidth - visibleWidth(content)))}${border("│")}`;
    }), bottom];
  }
}

export async function showCoachingOverlay(
  ctx: ExtensionContext,
  check: Promise<CoachingCheckResult>,
  signal?: AbortSignal,
  saveSnooze?: CoachingSnoozeHandler,
): Promise<CoachingOverlayDecision> {
  if (ctx.mode !== "tui") return "technical-failure";
  let overlay: CoachingOverlay | undefined;
  let close: (() => void) | undefined;
  let settled = false;
  let resolveDecision!: (decision: CoachingOverlayDecision) => void;
  const decision = new Promise<CoachingOverlayDecision>((resolve) => { resolveDecision = resolve; });
  const finish = (value: CoachingOverlayDecision): void => {
    if (settled) return;
    settled = true;
    overlay?.dispose();
    close?.();
    resolveDecision(value);
  };
  const abort = (): void => finish("send-unchecked");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const custom = Promise.resolve(ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      close = done;
      overlay = new CoachingOverlay({ tui, theme, keybindings, finish, ...(saveSnooze ? { saveSnooze } : {}) });
      void check.then(
        (result) => {
          if (result.kind === "matches") overlay?.setMatches(result.mistakes, result.targets);
          else finish(result.kind === "clean" ? "clean" : "technical-failure");
        },
        () => finish("technical-failure"),
      );
      if (signal?.aborted) abort();
      return overlay;
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "75%", minWidth: 56, maxHeight: "85%" },
    })).catch(() => finish("technical-failure"));
    await Promise.race([decision, custom]);
    return await decision;
  } finally {
    signal?.removeEventListener("abort", abort);
    overlay?.dispose();
    close?.();
  }
}
