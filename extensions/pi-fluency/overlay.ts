import type {
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { computeFluencyAnalytics, type FluencyAnalytics, type RuleAnalytics } from "./analytics.js";
import { compactDiffFallback, renderCompactDiff } from "./diff.js";
import type { FluencyStore } from "./store.js";
import type { ReviewPattern } from "./types.js";
import {
  ERRANT_CATEGORY_LABELS,
  errantCategory,
  type ErrantCategory,
} from "./taxonomy.js";

export type FluencyView = "inbox" | "accepted" | "ignored" | "stats";
type SelectionKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "tui.select.cancel";
export type IgnoreTarget = { kind: "pattern"; value: string } | { kind: "category"; value: ErrantCategory };
type MaybePromise = void | Promise<void>;

export interface FluencyOverlayOptions {
  tui: Pick<TUI, "requestRender"> & { terminal?: { readonly rows: number } };
  theme: Pick<Theme, "fg">;
  keybindings: { matches(data: string, keybinding: SelectionKeybinding): boolean };
  patterns(): ReviewPattern[];
  stats(): FluencyAnalytics;
  initialView?: FluencyView;
  ignoredBy?(pattern: ReviewPattern): IgnoreTarget[];
  selectIgnore?(title: string, options: string[]): Promise<string | undefined>;
  accept(id: string): MaybePromise;
  dismiss(id: string): MaybePromise;
  ignorePattern(patternKey: string, pattern: ReviewPattern): MaybePromise;
  ignoreCategory(category: ErrantCategory, pattern: ReviewPattern): MaybePromise;
  restoreIgnored(targets: IgnoreTarget[], pattern: ReviewPattern): MaybePromise;
  close(): void;
  viewChanged?(view: FluencyView): void;
  mutationError?(error: unknown): void;
}

const VIEWS: FluencyView[] = ["inbox", "accepted", "ignored", "stats"];
const FALLBACK_VERTICAL_BUDGET = 20;
const MIN_TERMINAL_ROWS = 15;
const HEADER_LINES = 2;
const FOOTER_LINES = 3;
const BORDER_LINES = 2;
const DETAIL_SCROLL_STEP = 5;

interface SourceSegment {
  text: string;
  start: number;
  end: number;
}

function sourceSegments(source: string, width: number): SourceSegment[] {
  let cursor = 0;
  return wrapTextWithAnsi(source, width).map((text) => {
    const start = source.indexOf(text, cursor);
    const safeStart = start < 0 ? cursor : start;
    cursor = safeStart + text.length;
    return { text, start: safeStart, end: cursor };
  });
}

function stringOffsetAtVisibleWidth(text: string, targetWidth: number): number {
  let offset = 0;
  for (const character of text) {
    if (visibleWidth(text.slice(0, offset)) >= targetWidth) break;
    offset += character.length;
  }
  return offset;
}

/** Wrap compact diff output while keeping a replacement annotation beside its source segment. */
export function wrapCompactDiff(lines: string[], marker: string, width: number): string[] {
  const linePrefixWidth = 3;
  const contentWidth = Math.max(1, width - linePrefixWidth);
  const wrapped: string[] = [];
  const append = (text: string): void => {
    wrapped.push(`${wrapped.length === 0 ? ` ${marker} ` : "   "}${text}`);
  };

  const fallback = compactDiffFallback(lines);
  if (fallback) {
    const arrow = "└─ ";
    const sharedWidth = Math.max(1, contentWidth - visibleWidth(arrow));
    const sourceLines = wrapTextWithAnsi(fallback.source, sharedWidth);
    const correctionLines = wrapTextWithAnsi(fallback.correction, sharedWidth);
    for (const line of sourceLines.length > 0 ? sourceLines : [""]) append(line);
    correctionLines.forEach((line, index) => append(`${index === 0 ? arrow : " ".repeat(visibleWidth(arrow))}${line}`));
    if (correctionLines.length === 0) append(arrow);
    return wrapped;
  }

  const annotation = lines.length === 2 ? lines[1]!.match(/^( *)(└─ )(.*)$/u) : null;
  if (annotation) {
    const source = lines[0]!;
    const arrow = annotation[2]!;
    // Leave enough room for the arrow and one correction column instead of
    // shifting the arrow left when the affected text is at a wrap boundary.
    const sourceWidth = Math.max(1, contentWidth - visibleWidth(arrow));
    const segments = sourceSegments(source, sourceWidth);
    const sourceOffset = stringOffsetAtVisibleWidth(source, visibleWidth(annotation[1]!));
    const affectedIndex = segments.findIndex((segment) => sourceOffset >= segment.start && sourceOffset < segment.end);
    if (affectedIndex >= 0) {
      for (const [index, segment] of segments.entries()) {
        append(segment.text);
        if (index !== affectedIndex) continue;

        const indentWidth = visibleWidth(source.slice(segment.start, sourceOffset));
        const correctionPrefix = `${" ".repeat(indentWidth)}${arrow}`;
        const correctionWidth = Math.max(1, contentWidth - visibleWidth(correctionPrefix));
        const correctionLines = wrapTextWithAnsi(annotation[3]!, correctionWidth);
        if (correctionLines.length === 0) append(correctionPrefix);
        else correctionLines.forEach((line, correctionIndex) => {
          append(`${correctionIndex === 0 ? correctionPrefix : " ".repeat(visibleWidth(correctionPrefix))}${line}`);
        });
      }
      return wrapped;
    }
  }

  for (const rawLine of lines) {
    const segments = wrapTextWithAnsi(rawLine, contentWidth);
    for (const segment of segments.length > 0 ? segments : [""]) append(segment);
  }
  return wrapped;
}

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").trim() || "Unknown error";
}

/** Disposable keyboard-first inbox used inside Pi custom overlay lifecycle. */
export class FluencyOverlay implements Component {
  private selectedIndex = 0;
  private detailOffset = 0;
  private maxDetailOffset = 0;
  private view: FluencyView = "inbox";
  private disposed = false;
  private loadError: string | undefined;
  private actionError: string | undefined;
  private callbacks: FluencyOverlayOptions | undefined;

  constructor(options: FluencyOverlayOptions) {
    this.callbacks = options;
    this.view = options.initialView ?? "inbox";
  }

  invalidate(): void {
    // Stateless rendering: theme styles are rebuilt on every render.
  }

  dispose(): void {
    this.disposed = true;
    this.callbacks = undefined;
  }

  private ignoredBy(pattern: ReviewPattern): IgnoreTarget[] {
    return this.callbacks?.ignoredBy?.(pattern) ?? [];
  }

  private getPatterns(): ReviewPattern[] {
    if (!this.callbacks) return [];
    try {
      const patterns = this.callbacks.patterns();
      this.loadError = undefined;
      return patterns;
    } catch (error) {
      this.loadError = sanitizedError(error);
      return [];
    }
  }

  private items(): ReviewPattern[] {
    if (this.view === "stats") return [];
    const items = this.getPatterns().filter((pattern) => {
      const ignored = this.ignoredBy(pattern).length > 0;
      if (this.view === "ignored") return ignored;
      if (ignored) return false;
      if (this.view === "accepted") return pattern.acceptedCount > 0;
      return pattern.pendingCount > 0;
    });
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, items.length - 1)));
    return items;
  }

  private changed(): void {
    if (this.disposed) return;
    this.callbacks?.tui.requestRender();
  }

  private clearActionError(): void {
    this.actionError = undefined;
  }

  private resetDetailPaging(): void {
    this.detailOffset = 0;
    this.maxDetailOffset = 0;
  }

  private clampSelectionAfterFilter(): void {
    this.items();
  }

  private async perform(action: () => MaybePromise, onSuccess: () => void): Promise<void> {
    this.clearActionError();
    this.changed();
    try {
      await action();
      if (this.disposed) return;
      onSuccess();
      this.actionError = undefined;
    } catch (error) {
      if (this.disposed) return;
      this.actionError = sanitizedError(error);
      try {
        this.callbacks?.mutationError?.(error);
      } catch {
        // Status integration is advisory; keep the card-local failure usable.
      }
    }
    this.changed();
  }

  async handleInput(data: string): Promise<void> {
    const callbacks = this.callbacks;
    if (this.disposed || !callbacks) return;
    const items = this.items();

    if (callbacks.keybindings.matches(data, "tui.select.cancel")) {
      callbacks.close();
      return;
    }
    if (data === "\t" || matchesKey(data, Key.tab)) {
      this.clearActionError();
      this.view = VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]!;
      this.selectedIndex = 0;
      this.resetDetailPaging();
      callbacks.viewChanged?.(this.view);
      this.changed();
      return;
    }
    if (this.view !== "stats" && matchesKey(data, Key.left)) {
      this.clearActionError();
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.resetDetailPaging();
      this.changed();
      return;
    }
    if (this.view !== "stats" && matchesKey(data, Key.right)) {
      this.clearActionError();
      this.selectedIndex = Math.min(Math.max(0, items.length - 1), this.selectedIndex + 1);
      this.resetDetailPaging();
      this.changed();
      return;
    }
    if (callbacks.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.clearActionError();
      this.detailOffset = Math.max(0, Math.min(this.detailOffset, this.maxDetailOffset) - 1);
      this.changed();
      return;
    }
    if (callbacks.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.clearActionError();
      this.detailOffset = Math.min(this.maxDetailOffset, this.detailOffset + 1);
      this.changed();
      return;
    }
    if (callbacks.keybindings.matches(data, "tui.select.pageUp")) {
      this.detailOffset = Math.max(0, Math.min(this.detailOffset, this.maxDetailOffset) - DETAIL_SCROLL_STEP);
      this.changed();
      return;
    }
    if (callbacks.keybindings.matches(data, "tui.select.pageDown")) {
      this.detailOffset = Math.min(this.maxDetailOffset, this.detailOffset + DETAIL_SCROLL_STEP);
      this.changed();
      return;
    }

    const selected = items[this.selectedIndex];
    if (!selected) return;
    if ((data === "a" || data === "l") && this.view === "inbox") {
      await this.perform(() => callbacks.accept(selected.id), () => {
        this.resetDetailPaging();
        this.clampSelectionAfterFilter();
      });
      return;
    }
    if (data === "d" && this.view === "inbox") {
      await this.perform(() => callbacks.dismiss(selected.id), () => {
        this.resetDetailPaging();
        this.clampSelectionAfterFilter();
      });
      return;
    }
    if (data === "i" && this.view !== "ignored") {
      await this.ignore(selected);
      return;
    }
    if (data === "u" && this.view === "ignored") await this.unignore(selected);
  }

  private async ignore(pattern: ReviewPattern): Promise<void> {
    const callbacks = this.callbacks;
    if (!callbacks) return;
    this.clearActionError();
    this.changed();
    const category = errantCategory(pattern.errorType);
    const exact = `Ignore only: ${pattern.explanation}`;
    const categoryOption = `Ignore this kind of mistake: ${ERRANT_CATEGORY_LABELS[category]}`;
    const options = [exact, categoryOption, "Cancel"];
    let selected: string | undefined;
    try {
      selected = callbacks.selectIgnore ? await callbacks.selectIgnore("Ignore fluency pattern", options) : exact;
    } catch (error) {
      if (!this.disposed) {
        this.actionError = sanitizedError(error);
        this.changed();
      }
      return;
    }
    if (this.disposed || !selected || selected === "Cancel") return;
    const rerenderFromAuthoritativeState = () => {
      this.resetDetailPaging();
      this.clampSelectionAfterFilter();
    };
    if (selected === exact) {
      await this.perform(
        () => callbacks.ignorePattern(pattern.patternKey, pattern),
        rerenderFromAuthoritativeState,
      );
      return;
    }
    if (selected !== categoryOption) return;
    await this.perform(
      () => callbacks.ignoreCategory(category, pattern),
      rerenderFromAuthoritativeState,
    );
  }

  private async unignore(pattern: ReviewPattern): Promise<void> {
    const callbacks = this.callbacks;
    if (!callbacks) return;
    const seen = new Set<string>();
    const targets = this.ignoredBy(pattern).filter((target) => {
      const key = `${target.kind}:${target.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (targets.length === 0) return;

    await this.perform(
      () => callbacks.restoreIgnored(targets, pattern),
      () => {
        this.resetDetailPaging();
        this.clampSelectionAfterFilter();
      },
    );
  }

  private verticalBudget(): number {
    const rows = this.callbacks?.tui.terminal?.rows;
    if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) return FALLBACK_VERTICAL_BUDGET;
    return Math.max(HEADER_LINES + FOOTER_LINES + BORDER_LINES + 1, Math.min(Math.floor(rows * 0.8), rows - 2));
  }

  private visiblePatternLines(pattern: ReviewPattern, width: number, available: number): string[] {
    if (available <= 0) {
      this.resetDetailPaging();
      return [];
    }
    const diff = renderCompactDiff(pattern, {
      deletion: (text) => this.callbacks?.theme.fg("error", `\u001b[9m${text}\u001b[29m`) ?? text,
      insertion: (text) => this.callbacks?.theme.fg("success", `\u001b[4m${text}\u001b[24m`) ?? text,
    });
    const body = [...wrapCompactDiff(diff, "›", width), ""];
    for (const line of wrapTextWithAnsi(pattern.explanation, Math.max(1, width - 2))) body.push(` ${line}`);
    this.maxDetailOffset = Math.max(0, body.length - available);
    this.detailOffset = Math.min(this.detailOffset, this.maxDetailOffset);
    return body.slice(this.detailOffset, this.detailOffset + available);
  }

  private getStats(): FluencyAnalytics | undefined {
    try {
      const stats = this.callbacks?.stats();
      this.loadError = undefined;
      return stats;
    } catch (error) {
      this.loadError = sanitizedError(error);
      return undefined;
    }
  }

  private ruleTrend(rule: RuleAnalytics): string {
    if (rule.trend === "new") return "✦ new";
    if (rule.trend === "stable") return "→";
    const arrow = rule.trend === "improving" ? "↓" : "↑";
    const change = rule.changePercent === undefined ? "" : `${Math.abs(Math.round(rule.changePercent))}%`;
    return `${arrow}${change}`;
  }

  private statsLines(stats: FluencyAnalytics, width: number): string[] {
    const body: string[] = [];
    const append = (text = ""): void => {
      const wrapped = wrapTextWithAnsi(text, Math.max(1, width - 1));
      if (wrapped.length === 0) body.push("");
      else for (const line of wrapped) body.push(` ${line}`);
    };
    const periodRate = stats.periodRatePerThousand === undefined
      ? "—"
      : stats.periodRatePerThousand.toFixed(1);
    const currentRate = stats.currentRatePerThousand === undefined
      ? "—"
      : stats.currentRatePerThousand.toFixed(1);
    const coverage = stats.reviewCoverage === undefined
      ? "—"
      : `${Math.round(stats.reviewCoverage * 100)}%`;

    append("Fluency trend · 30 days");
    append();
    append(`Accepted rate       ${periodRate} / 1000 English words`);
    append(`English words       ${stats.englishWords.toLocaleString("en-US")}`);
    append(`Accepted            ${stats.accepted.toLocaleString("en-US")}`);
    append(`One-off accepted mistakes  ${stats.oneOffAccepted.toLocaleString("en-US")}`);
    append(`Dismissed           ${stats.dismissed.toLocaleString("en-US")}`);
    append(`Pending             ${stats.periodPendingOccurrences.toLocaleString("en-US")}`);
    append(`Review coverage     ${coverage}`);
    append(`Active rules        ${stats.activeRules.toLocaleString("en-US")}`);
    append(`${stats.toolbarSparkline}  ${currentRate === "—" ? "—/k" : `${currentRate}/k`}`);
    append();
    append("Concrete rules");
    append(`↓ ${stats.trendCounts.improving} improving   ↑ ${stats.trendCounts.worsening} worsening   → ${stats.trendCounts.stable} stable   ✦ ${stats.trendCounts.new} new`);
    append();
    if (stats.rules.length === 0) {
      append("No recurring concrete rules in this period.");
    } else {
      for (const rule of stats.rules) {
        append(rule.explanation);
        const ruleRate = rule.ratePerThousand === undefined ? "—/k" : `${rule.ratePerThousand.toFixed(1)}/k`;
        append(`${ruleRate}  ${this.ruleTrend(rule)}  ${rule.sparkline}`);
        append();
      }
    }
    return body;
  }

  private visibleStatsLines(stats: FluencyAnalytics, width: number, available: number): string[] {
    if (available <= 0) {
      this.resetDetailPaging();
      return [];
    }
    const body = this.statsLines(stats, width);
    this.maxDetailOffset = Math.max(0, body.length - available);
    this.detailOffset = Math.min(this.detailOffset, this.maxDetailOffset);
    return body.slice(this.detailOffset, this.detailOffset + available);
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const safeWidth = Math.max(0, width);
    if (safeWidth < 2) return safeWidth === 1 ? [this.callbacks?.theme.fg("border", "│") ?? "│"] : [];
    const contentWidth = safeWidth - 2;
    const budget = this.verticalBudget();
    const innerBudget = Math.max(0, budget - BORDER_LINES);
    const items = this.items();
    const stats = this.view === "stats" ? this.getStats() : undefined;
    const title = ` Pi Fluency · ${this.view[0]!.toUpperCase()}${this.view.slice(1)}`;
    const noun = this.view === "inbox" ? "pending" : this.view;
    const selected = items[this.selectedIndex];
    const paging = this.view === "stats"
      ? "30 days"
      : selected
        ? `Pending ${selected.pendingCount} · accepted ${selected.acceptedCount} · ← ${this.selectedIndex + 1} / ${items.length} →`
        : `0 ${noun}`;
    const combinedHeaderWidth = visibleWidth(title) + 1 + visibleWidth(paging);
    const headerLines = combinedHeaderWidth <= contentWidth
      ? [title + " ".repeat(contentWidth - visibleWidth(title) - visibleWidth(paging)) + paging]
      : [title, ...wrapTextWithAnsi(` ${paging}`, contentWidth)];
    const lines: string[] = [...headerLines, ` ${"─".repeat(Math.max(0, contentWidth - 2))}`];

    if (this.loadError) {
      this.resetDetailPaging();
      lines.push(` Could not load ${this.view === "stats" ? "statistics" : "patterns"}: ${this.loadError}`);
    } else if (this.view === "stats" && stats) {
      const reserved = headerLines.length + 1 + FOOTER_LINES;
      lines.push(...this.visibleStatsLines(stats, contentWidth, Math.max(1, innerBudget - reserved)));
    } else {
      if (this.actionError) lines.push(` Action failed: ${this.actionError}`);
      if (items.length === 0) {
        this.resetDetailPaging();
        lines.push(this.view === "inbox" ? " No pending patterns." : ` No ${this.view} patterns.`);
      } else {
        const reserved = headerLines.length + 1 + FOOTER_LINES + (this.actionError ? 1 : 0);
        lines.push(...this.visiblePatternLines(selected!, contentWidth, Math.max(1, innerBudget - reserved)));
      }
    }

    lines.push(` ${"─".repeat(Math.max(0, contentWidth - 2))}`);
    if (this.view === "stats") {
      lines.push(" ↑↓/jk scroll  pgup/pgdn");
      lines.push(" tab view  esc close");
    } else {
      if (this.view === "inbox") lines.push(" ←→ card  ↑↓/jk scroll  a accept  d dismiss");
      else lines.push(" ←→ card  ↑↓/jk scroll");
      lines.push(this.view === "ignored" ? " u restore all  tab view  esc close" : " i ignore  tab view  esc close");
    }

    const border = (text: string): string => this.callbacks?.theme.fg("border", text) ?? text;
    const top = border(`╭${"─".repeat(contentWidth)}╮`);
    const bottom = border(`╰${"─".repeat(contentWidth)}╯`);
    const framed = lines.slice(0, innerBudget).map((line) => {
      const content = truncateToWidth(line, contentWidth, "");
      const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
      return `${border("│")}${content}${padding}${border("│")}`;
    });
    return [top, ...framed, bottom];
  }
}

export async function showFluencyOverlay(
  ctx: ExtensionContext,
  store: FluencyStore,
  signal?: AbortSignal,
  onProgressChanged?: () => void,
  onMutationError?: (error: unknown) => void,
  initialView: FluencyView = "inbox",
  now: () => number = Date.now,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Pi Fluency inbox requires interactive TUI mode", "warning");
    return;
  }
  let overlay: FluencyOverlay | undefined;
  let close: (() => void) | undefined;
  const abort = (): void => {
    overlay?.dispose();
    close?.();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        close = done;
        overlay = new FluencyOverlay({
          tui,
          theme,
          keybindings,
          patterns: () => store.listReviewPatterns(),
          stats: () => {
            const snapshot = store.getAnalyticsSnapshot();
            return computeFluencyAnalytics({
              observations: snapshot.observations,
              occurrences: snapshot.occurrences,
              patterns: snapshot.patterns,
              ignoredPatternKeys: new Set(snapshot.ignoredPatternKeys),
              ignoredCategories: new Set(snapshot.ignoredCategories),
              now: now(),
            });
          },
          initialView,
          ignoredBy: (pattern) => {
            const settings = store.getSettings();
            const targets: IgnoreTarget[] = [];
            if (settings.ignoredPatternKeys.includes(pattern.patternKey)) {
              targets.push({ kind: "pattern", value: pattern.patternKey });
            }
            const category = errantCategory(pattern.errorType);
            if (settings.ignoredCategories.includes(category)) {
              targets.push({ kind: "category", value: category });
            }
            return targets;
          },
          selectIgnore: (title, options) => ctx.ui.select(title, options),
          accept: async (id) => {
            await store.acceptPattern(id);
            onProgressChanged?.();
          },
          dismiss: async (id) => {
            await store.dismissPattern(id);
            onProgressChanged?.();
          },
          ignorePattern: async (patternKey) => {
            await store.ignorePatternKey(patternKey);
            onProgressChanged?.();
          },
          ignoreCategory: async (category) => {
            await store.ignoreCategory(category);
            onProgressChanged?.();
          },
          restoreIgnored: async (targets) => {
            await store.restoreIgnoreTargets({
              patternKeys: targets.filter((target) => target.kind === "pattern").map((target) => target.value),
              categories: targets.filter((target): target is Extract<IgnoreTarget, { kind: "category" }> => target.kind === "category")
                .map((target) => target.value),
            });
            onProgressChanged?.();
          },
          ...(onMutationError ? { mutationError: onMutationError } : {}),
          close: () => done(),
        });
        if (signal?.aborted) abort();
        return overlay;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "75%",
          minWidth: 56,
          maxHeight: "80%",
          margin: 1,
          visible: (_width, height) => height >= MIN_TERMINAL_ROWS,
        },
      },
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    overlay?.dispose();
    overlay = undefined;
    close = undefined;
  }
}
