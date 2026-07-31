# Enter Practice Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `s` with Enter as practice-check proceed action, default matched focus to Send once, and raise total foreground cap to 30 seconds.

**Architecture:** Keep the existing checkpoint state machine and decision types. Change only key mapping/default focus/rendered help in `coaching-overlay.ts`, then update the named timeout constants and exact notices in `index.ts`. Public component and extension tests prove key consumption, single-send behavior, navigation, and exact total deadline.

**Tech Stack:** TypeScript ESM, Pi extension/TUI APIs, Vitest 3, Node.js 22.19+.

## Global Constraints

- Enter or configured `tui.select.confirm` sends unchecked during checking.
- Enter confirms focused action after findings; initial focused action is Send once.
- Escape/configured cancel always edits.
- Remove direct `s` behavior and rendered `s` help from checking and matched states.
- Keep `e`, `t`, and `5` direct matched shortcuts.
- Total foreground cap is exactly 30,000 ms including 100 ms abort grace; coordinator deadline is 29,900 ms.
- Successful checks return immediately; Enter remains immediate bypass.
- Preserve fail-open, editor, single-send, shutdown, authorization, background enqueue, conditional persistence, snooze, and schema behavior.
- No test or script may touch real `~/.pi/agent/pi-fluency/` history.

---

### Task 1: Use Enter to proceed and extend practice cap

**Files:**
- Modify: `extensions/pi-fluency/coaching-overlay.ts`
- Modify: `extensions/pi-fluency/index.ts`
- Modify: `README.md`
- Test: `tests/coaching-overlay.test.ts`
- Test: `tests/extension.test.ts`

**Interfaces:**
- Preserves: `CoachingOverlayDecision`, `showCoachingOverlay()`, and `FluencyWorker.analyzeForeground()` signatures.
- Changes internal constants: `PRACTICE_CHECK_TIMEOUT_MS = 30_000`, coordinator budget `29_900`.

- [ ] **Step 1: Add failing component key tests**

In `tests/coaching-overlay.test.ts`, assert:

```ts
component.handleInput(Key.enter);
expect(finish).toHaveBeenCalledWith("send-unchecked");
```

for checking mode. Assert `s` does not finish.

After `setMatches()`, assert initial Enter returns `send-once`. Add arrow navigation cases proving Up selects Edit and Down can select snoozes before Enter confirmation. Assert matched `s` does nothing and Escape still returns Edit.

Update exact rendered help expectations:

```text
Enter Send unchecked   esc Edit
```

and:

```text
Enter confirm   esc Edit
```

- [ ] **Step 2: Add failing public extension timing/single-send tests**

Update public extension tests to drive Enter through real `showCoachingOverlay` component seam where available. Prove checking Enter:

- resolves original input once with `continue`
- clears editor once
- emits `Sent without practice check — analyzer cancelled.`
- creates no duplicate foreground commit

Update fake-timer tests:

```ts
await vi.advanceTimersByTimeAsync(12_100);
expect(inputSettled).toBe(false);
analyzerResult.resolve(cleanResult);
await expect(input).resolves.toEqual({ action: "continue" });
```

Add abort-ignoring timeout test proving unresolved at 29,999 ms and fail-open at exactly 30,000 ms.

Expected notices:

```text
Sent without practice check — analyzer was busy for 30 seconds.
Sent without practice check — analyzer timed out after 30 seconds.
```

- [ ] **Step 3: Run tests and verify RED**

```bash
npx vitest run tests/coaching-overlay.test.ts tests/extension.test.ts
```

Expected: Enter ignored while checking, matched Enter selects Edit, `s` still proceeds, and 12-second timing assertions fail.

- [ ] **Step 4: Implement overlay key semantics**

In `CoachingOverlay`:

```ts
private selectedAction = 1;
```

During checking:

```ts
if (cancel) this.options.finish("edit");
else if (data === Key.enter || this.matches(data, "tui.select.confirm")) {
  this.options.finish("send-unchecked");
}
```

Delete both `data.toLowerCase() === "s"` branches. Keep matched Enter's selected-action confirmation and all existing navigation/saving guards.

Replace help lines with Enter-based copy. Keep every rendered line width-bounded by existing truncation.

- [ ] **Step 5: Implement 30-second total cap**

In `index.ts`:

```ts
const PRACTICE_CHECK_TIMEOUT_MS = 30_000;
const PRACTICE_CHECK_ABORT_GRACE_MS = 100;
```

Continue deriving coordinator deadline by subtracting abort grace. Update busy and timeout copy to 30 seconds. Do not create phase-local deadlines.

Update README from `s`/12 seconds to Enter/30 seconds. State successful checks proceed immediately.

- [ ] **Step 6: Verify GREEN**

```bash
npx vitest run tests/coaching-overlay.test.ts tests/extension.test.ts tests/worker.test.ts
npm run check
git diff --check
```

Expected: all tests and typecheck pass; no schema fixtures change.

- [ ] **Step 7: Commit**

```bash
git add extensions/pi-fluency/coaching-overlay.ts extensions/pi-fluency/index.ts README.md tests/coaching-overlay.test.ts tests/extension.test.ts
git commit -m "feat: use Enter for practice bypass"
```

---

## Final Review

- Run independent correctness and TUI review over branch diff.
- Fix every confirmed blocker/important finding with public-seam regression coverage.
- Run:

```bash
npm run check && git diff --check && test -z "$(git status --short)"
```

- Merge only after review is clean.
