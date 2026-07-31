# Inline Stats Practice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate Practice target screen with focused inline Stats checkboxes and add a full 30-position daily mistakes-per-1,000 chart.

**Architecture:** Analytics adds one presentation-ready daily sparkline without changing history. `FluencyOverlay` keeps stable rule focus inside Stats, derives recurring/historical/Ignore-paused rows from existing practice state, and scrolls the viewport to the focused row. Existing store mutations remain authoritative; obsolete Practice-view state and confirmations are deleted.

**Tech Stack:** TypeScript ESM, Pi extension/TUI APIs, Vitest 3, Node.js 22.19+.

## Global Constraints

- Keep analyzer schema v3, settings schema v3, history schema v4, and practice sidecar schema v1 unchanged.
- Only interactive human prompts remain eligible for analysis; this UI change must not alter preflight provenance or privacy behavior.
- Internal pattern IDs, pattern keys, row keys, and ERRANT codes must never render.
- Practice checkboxes are empty by default; `Space` is the only inline toggle action.
- Up/Down and `j`/`k` move rule focus and scroll the Stats viewport to keep the focused rule visible.
- Daily chart contains exactly 30 local-calendar-day positions, oldest to newest; `·` means no English words that day.
- Existing seven-position toolbar and per-rule sparklines remain unchanged.
- No test or script may touch real `~/.pi/agent/pi-fluency/` history.

---

### Task 1: Add thirty-day daily rate chart

**Files:**
- Modify: `extensions/pi-fluency/analytics.ts`
- Test: `tests/analytics.test.ts`
- Modify: `tests/helpers/overlay-fixtures.ts`

**Interfaces:**
- Produces: `FluencyAnalytics.dailyRateSparkline: string`, exactly 30 glyphs.
- Preserves: `toolbarSparkline` and every `RuleAnalytics.sparkline` at seven glyphs.

- [ ] **Step 1: Add failing daily-chart analytics tests**

Add tests that construct observations and accepted occurrences on explicit local dates and assert:

```ts
expect(result.dailyRateSparkline).toHaveLength(30);
expect(result.dailyRateSparkline[0]).toBe("·"); // no words
expect(result.dailyRateSparkline.at(-1)).not.toBe("·"); // words collected today
expect(result.toolbarSparkline).toHaveLength(7);
```

Cover: oldest/current boundary inclusion, 31-days-ago exclusion, a word-bearing zero-accepted day rendering the lowest bar, no-word gaps, and all-empty period producing `"·".repeat(30)`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run tests/analytics.test.ts
```

Expected: failure because `dailyRateSparkline` is absent.

- [ ] **Step 3: Compute daily normalized rates**

In `FluencyAnalytics`, add:

```ts
dailyRateSparkline: string;
```

Inside `computeFluencyAnalytics`, derive oldest-to-newest values:

```ts
const dailyRates = Array.from({ length: TREND_DAYS }, (_, index) => {
  const date = shiftDate(today, index - (TREND_DAYS - 1));
  const day = totals(date, 1);
  return ratePerThousand(day.accepted, day.words);
});
```

Return `dailyRateSparkline: renderSparkline(dailyRates)`. Do not reuse it for toolbar/per-rule fields.

- [ ] **Step 4: Update typed fixtures and verify GREEN**

Add `dailyRateSparkline: "·".repeat(30)` to shared `emptyStats` and explicit `FluencyAnalytics` fixtures. Run:

```bash
npx vitest run tests/analytics.test.ts tests/overlay-rendering.test.ts tests/overlay.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add extensions/pi-fluency/analytics.ts tests/analytics.test.ts tests/helpers/overlay-fixtures.ts tests/overlay-rendering.test.ts tests/overlay.test.ts
git commit -m "feat: add thirty-day fluency chart"
```

---

### Task 2: Move practice selection into focused Stats rows

**Files:**
- Modify: `extensions/pi-fluency/overlay.ts`
- Modify: `tests/helpers/overlay-fixtures.ts`
- Test: `tests/overlay.test.ts`
- Test: `tests/overlay-rendering.test.ts`

**Interfaces:**
- Consumes: `FluencyAnalytics.rules`, `FluencyAnalytics.dailyRateSparkline`, `PracticeOverlayState`, `activatePractice`, and `setPracticeTarget` callbacks.
- Produces: Stats-only keyboard interaction; `FluencyView` no longer includes `"practice"`.

- [ ] **Step 1: Add failing inline-render tests**

Update Stats expectations to require:

```text
Mistakes / 1,000 words · last 30 days
<30-glyph sparkline>  8.4/k
30 days ago ... today
> [ ] first rule
  [x] selected rule
```

Assert the rendered Stats output does not contain `p practice targets`, `Pi Fluency · Practice`, `[Selected for practice]`, internal IDs, or confirmation copy. Add narrow/short terminal cases proving focused checkbox and footer remain visible.

- [ ] **Step 2: Add failing focus/navigation/mutation tests**

Public overlay tests must prove:

- Stats starts with first recurring row focused.
- Down/`j` and Up/`k` move focus one row and trigger a rerender.
- Focus movement scrolls enough to keep focused explanation and metadata visible in a 15-row terminal.
- `Space` on an unselected row calls `activatePractice(target)` when consent is absent; no modal appears.
- `Space` on later rows calls `setPracticeTarget(target, selected)`.
- Pending mutation freezes navigation/toggle; failure retains checkbox/focus and shows sanitized error.
- Selected non-recurring and Ignore-paused targets render after recurring rows and remain toggleable.
- Focus remains on same `rowKey` after successful rerender/order changes, otherwise clamps to nearest row.
- Empty Stats has no focus and ignores `Space`.

Run:

```bash
npx vitest run tests/overlay.test.ts tests/overlay-rendering.test.ts
```

Expected: failures under separate Practice-view behavior.

- [ ] **Step 3: Collapse Practice state into Stats**

In `overlay.ts`:

- Change `FluencyView` to `"inbox" | "accepted" | "ignored" | "stats"`.
- Delete `PracticeConfirmation`, confirmation focus/reset state, `handlePracticeInput`, `practiceBodyLines`, `confirmationLines`, and `data === "p"` transition.
- Rename practice cursor fields to Stats-rule names, for example:

```ts
private statsRuleIndex = 0;
private statsRuleFocusKey: string | undefined;
private statsRulePending = false;
```

- Reuse/refactor `practiceRows()` into `statsRuleRows()` returning recurring, historical selected, and Ignore-paused rows.
- Handle Stats keys before generic vertical scrolling:

```ts
if (this.view === "stats" && isUp(data)) moveStatsRuleFocus(-1);
if (this.view === "stats" && isDown(data)) moveStatsRuleFocus(1);
if (this.view === "stats" && data === " ") await toggleFocusedStatsRule();
```

When consent is absent and an unselected row is toggled, call `activatePractice(row.target)` directly; this existing atomic store mutation records consent, selects target, and enables practice in one replacement. No confirmation UI.

- [ ] **Step 4: Render focus-aware Stats body**

Build Stats lines with rule-line metadata so `visibleStatsLines()` can calculate the focused row's line range. Render:

```ts
const marker = index === this.statsRuleIndex ? ">" : " ";
const checkbox = row.selected ? "[x]" : "[ ]";
append(`${marker} ${checkbox} ${row.target.explanation}`);
```

Add section labels only when historical or Ignore-paused rows exist. For paused rows append concise `paused by Ignore` text, not internal metadata. On every render, adjust `detailOffset` only enough to keep focused rule title and rate/trend line in the available window; initial Stats render keeps top chart visible while first rule is focused unless terminal height makes that impossible.

Render chart before summary metrics:

```text
Mistakes / 1,000 words · last 30 days
${stats.dailyRateSparkline}  ${periodRate}/k
30 days ago ... today
```

Use footer:

```text
↑↓/jk focus + scroll   Space toggle   tab view   esc close
```

Wrap it into multiple textual lines at compact widths.

- [ ] **Step 5: Verify focused Stats behavior**

Run:

```bash
npx vitest run tests/overlay.test.ts tests/overlay-rendering.test.ts tests/analytics.test.ts
npm run typecheck
```

Expected: all pass; no Practice-view references remain in source except domain concepts such as practice settings/targets.

- [ ] **Step 6: Commit Task 2**

```bash
git add extensions/pi-fluency/overlay.ts tests/helpers/overlay-fixtures.ts tests/overlay.test.ts tests/overlay-rendering.test.ts
git commit -m "feat: select practice rules in Stats"
```

---

### Task 3: Remove obsolete navigation and update product documentation

**Files:**
- Modify: `extensions/pi-fluency/index.ts`
- Modify: `README.md`
- Modify: `tests/extension.test.ts`
- Modify: `tests/manual/fake-extension.ts`
- Modify: `docs/plans/2026-07-31-001-feat-proactive-fluency-preflight-plan.md`
- Test: `tests/extension.test.ts`

**Interfaces:**
- Preserves direct commands: `/fluency practice on|off|resume|reset`.
- Changes `/fluency practice` to open Stats.

- [ ] **Step 1: Add failing command tests**

Assert `/fluency stats` and bare `/fluency practice` both open `initialView: "stats"`. Assert direct practice subcommands still mutate the same authoritative state and notifications. Remove tests expecting a Practice view or `p` navigation.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run tests/extension.test.ts tests/overlay.test.ts
```

Expected: `/fluency practice` still opens obsolete `"practice"` view.

- [ ] **Step 3: Route command and clean documentation**

Change:

```ts
if (action === "practice") {
  await openInbox(ctx, store, "stats");
  return;
}
```

Update README TUI and instructions:

- Show `[ ]` / `[x]` rows directly in Stats.
- Explain first rule focus, arrow/j/k focus-following scroll, and Space toggle.
- Show the 30-position daily normalized chart and `·` no-word meaning.
- Remove `p`, separate Practice-screen, selection explanation, and confirmation references.
- Keep direct master/snooze commands and pre-send consent/provider disclosure accurate.

Update manual harness instructions and mark superseded implementation-plan references accurately; do not rewrite historical design decisions as if they never existed.

- [ ] **Step 4: Run full verification**

```bash
npm run check
git diff --check
```

Expected: typecheck passes, all tests pass, and no whitespace errors remain.

- [ ] **Step 5: Isolated real-Pi dogfood**

With both `HOME` and `PI_CODING_AGENT_DIR` under one temporary root, install this checkout through real Pi package discovery. Open `/fluency stats` and verify:

- 30-position chart and oldest/today labels render.
- Inline checkbox and focus marker render when seeded temp fixtures provide a recurring rule.
- No `p practice targets` footer or separate Practice title appears.
- Temp history remains isolated and private; delete temporary root afterward.

Do not inspect, edit, or clear real user history.

- [ ] **Step 6: Commit Task 3 and verify clean state**

```bash
git add extensions/pi-fluency/index.ts README.md tests/extension.test.ts tests/manual/fake-extension.ts docs/plans/2026-07-31-001-feat-proactive-fluency-preflight-plan.md
git commit -m "docs: explain inline Stats practice"
test -z "$(git status --short)"
```

Expected: task commit succeeds and tracked worktree is clean.

---

## Final Review

- Run independent correctness and TUI reviews against the complete branch diff.
- Fix every confirmed blocker/important finding with a public-seam regression test.
- Rerun `npm run check && git diff --check && test -z "$(git status --short)"` in a fresh shell.
- Merge only after review reports no blockers and fresh verification passes.
