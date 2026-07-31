# Inline Stats Practice Selection

## Status

Approved for implementation.

## Problem

Practice rule selection currently opens a separate screen with its own navigation, explanatory disclosure, and confirmation flow. That makes a simple on/off choice feel like a mode switch. Stats already displays the relevant recurring rules, so selection should happen where those rules are evaluated.

The top Stats trend also shows only seven rolling values. Users want a direct view of every local calendar day in the current 30-day period.

## Goals

- Toggle practice rules directly in the Stats rule list.
- Make selection state visible without opening another view.
- Use one focus cursor shared by keyboard navigation and scrolling.
- Show all 30 daily accepted-mistake rates in the Stats summary.
- Preserve durable targets, Ignore suppression, snoozes, analytics consent boundaries, and pre-send coaching behavior.

## Non-goals

- No mouse interaction.
- No broad ERRANT-category selection.
- No live editor linting.
- No change to recurring-rule qualification or 30-day retention.
- No redesign of Inbox, Accepted, or Ignored views.

## Interaction Design

Stats becomes the only rule-selection surface.

```text
╭──────────────────────────────────────────────────────────────╮
│ Pi Fluency · Stats                                   30 days │
│ ──────────────────────────────────────────────────────────── │
│ Mistakes / 1,000 words · last 30 days                        │
│ ▁▂▁·▃▂▄▁▁▅▃▂▂▁·▁▃▄▆▃▂▁▂▄▃▂▁▁▂▃  8.4/k                      │
│ 30 days ago                                      today       │
│                                                              │
│ Accepted rate       8.4 / 1000 English words                │
│ English words       5,732                                   │
│ Accepted            48                                      │
│                                                              │
│ Concrete rules                                              │
│                                                              │
│ > [ ] Use an article before a singular countable noun.      │
│       5.7/k  ✦ new  ···▁▆██                                 │
│                                                              │
│   [x] Use a period to separate independent clauses.         │
│       3.5/k  ✦ new  ···▁▃▆█                                 │
│                                                              │
│   [ ] A direct question should end with a question mark.    │
│       2.9/k  ✦ new  ···▁▁▆█                                 │
│                                                              │
│ ──────────────────────────────────────────────────────────── │
│ ↑↓/jk focus + scroll   Space toggle   tab view   esc close  │
╰──────────────────────────────────────────────────────────────╯
```

State notation:

- `> [ ]` focused and not selected.
- `> [x]` focused and selected.
- `  [ ]` unfocused and not selected.
- `  [x]` unfocused and selected.

The first selectable rule is focused when Stats opens. Up/Down and `j`/`k` move focus one rule at a time. The viewport scrolls only as needed to keep the focused rule and its metadata visible. `Space` immediately toggles the focused rule through the authoritative store mutation. While persistence is pending, repeated input is ignored and the current checkbox remains authoritative until success. Failure retains the old checkbox and shows a sanitized inline error.

There is no separate Practice view, no selection explanation page, and no confirmation modal. Selecting the first rule also enables practice and records practice consent atomically. A compact Stats status line states that selected rules are checked before send, providing context without interrupting the flow.

`/fluency practice` opens Stats. Existing direct controls remain:

- `/fluency practice on`
- `/fluency practice off`
- `/fluency practice resume`
- `/fluency practice reset`

A selected rule that leaves the recurring 30-day list remains visible in a final **Selected, not currently recurring** section so no active target becomes invisible. Ignore-suppressed selections remain visible and marked paused by Ignore.

## Thirty-day Chart

The top chart contains exactly 30 positions ordered oldest to newest by local calendar date.

Each position is the accepted-mistake rate for that day:

```text
accepted findings / English words × 1000
```

- `·` means no English words were collected that day, so no rate exists.
- A day with English words and zero accepted findings renders the lowest bar.
- Bars scale against the maximum finite daily rate in the 30-day period.
- The summary value at the right remains the aggregate 30-day rate, not the final day's rate.
- Existing seven-value toolbar and per-rule sparklines remain unchanged.

## Data and Architecture

- Extend `FluencyAnalytics` with one presentation-ready 30-position daily sparkline.
- Compute daily rates from existing observations and accepted occurrences; add no history fields.
- Reuse durable practice targets and atomic activation/toggle mutations.
- Move Stats from offset-only scrolling to rule-focus-aware rendering. Keep focus keyed by stable rule row key so async rerenders and ordering changes retain the same rule when possible.
- Remove `practice` from `FluencyView`, delete separate Practice rendering/input/confirmation state, and route `/fluency practice` to Stats.
- Keep master mode, consent, timed snooze, session snooze, and Reset persistence unchanged.

## Alternatives Considered

1. **Inline checkbox rows — selected.** Lowest interaction cost and keeps decision beside evidence.
2. **Separate Practice screen — rejected.** Current implementation duplicates the Stats list and introduces unnecessary mode, navigation, disclosure, and confirmation state.
3. **Numbered toggle commands without focus — rejected.** Harder to scan, fragile when sorting changes, and less discoverable.

For the chart:

1. **Thirty daily normalized rates — selected.** Shows every requested day while accounting for writing volume.
2. **Seven rolling weekly rates — rejected for Stats.** Smooth but hides daily shape; remains suitable for compact toolbar/rule sparklines.
3. **Raw daily accepted counts — rejected.** Confounds writing volume with error rate.

## Error and Edge Behavior

- No rules: show empty rule state; no focus and Space does nothing.
- Focused rule ages out after mutation/rerender: retain it in historical selected section; otherwise clamp to nearest remaining row.
- Narrow terminals: checkbox, focus marker, rule explanation, and footer action remain visible; metadata may wrap below.
- Store mutation failure: retain prior selected state and focus; show bounded sanitized error.
- First activation failure: atomic mutation leaves consent, target, and enabled state unchanged.
- Reset removes all selections; Stats returns to first recurring rule focused.

## Testing

- Characterize existing Stats metrics, ordering, scrolling, and toolbar/per-rule sparklines.
- Test 30 positions, local-day boundaries, no-word gaps, zero-rate days, scaling, and aggregate-rate label.
- Test first-focus, Up/Down/j/k navigation, focus-following viewport, Space toggle, pending-input freeze, persistence failure, stable focus after rerender, historical selected rows, and Ignore-paused rows.
- Test removal of the separate Practice view and `p` shortcut.
- Test `/fluency practice` opens Stats while direct subcommands remain functional.
- Verify narrow and short terminal rendering.

## Documentation

Update README TUI and practice instructions to show inline checkboxes and remove references to `p` or a separate Practice target screen.
