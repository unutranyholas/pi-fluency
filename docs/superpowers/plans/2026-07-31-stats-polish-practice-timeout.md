# Stats Polish and Practice Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove misleading new-rule annotations, align Stats rule continuation content, and make pre-send practice checks tolerate normal model latency while reporting exact failure classes.

**Architecture:** Keep analytics and persisted schemas unchanged. Stats rendering gains one hanging-indent helper and suppresses the existing `new` presentation. Input orchestration replaces the six-second literal with a named 12-second deadline and maps coordinator outcomes/policy failures to precise bounded notices without changing fail-open or persistence fences.

**Tech Stack:** TypeScript ESM, Pi extension/TUI APIs, Vitest 3, Node.js 22.19+.

## Global Constraints

- Total foreground practice deadline is 12 seconds; successful checks return immediately.
- `s` continues to send immediately without a practice check.
- Fail-open, editor preservation, authorization, background enqueue, and conditional persistence behavior remain unchanged.
- Remove `✦ new` from per-rule metadata and aggregate Stats copy only; retain internal trend classification and sorting.
- Add no durable seen state and change no analyzer, settings, history, or practice schema.
- Wrapped rule labels, metadata, and focused action errors align after the six-column `> [x] ` prefix.
- Rendered output remains bounded by supplied terminal width and exposes no internal IDs or prompt prose.
- No test or script may touch real `~/.pi/agent/pi-fluency/` history.

---

### Task 1: Polish Stats rule rendering

**Files:**
- Modify: `extensions/pi-fluency/overlay.ts`
- Test: `tests/overlay-rendering.test.ts`
- Test: `tests/overlay.test.ts`

**Interfaces:**
- Consumes: `RuleAnalytics.trend`, existing `wrapTextWithAnsi()`, `StatsRuleRow`, and Stats focus state.
- Produces: hanging-indented rule line ranges used by `visibleStatsLines()`; no public type changes.

- [ ] **Step 1: Add failing presentation tests**

Add public rendering fixtures with one long focused rule, one long unfocused rule, and a focused mutation failure. Assert exact visible content:

```text
> [x] Use an article before a singular
      countable noun.
      5.7/k  ···▁▆██
```

Assertions must prove:

```ts
expect(output).not.toContain("✦ new");
expect(output).not.toMatch(/\b\d+ new\b/);
const labelColumn = firstTitleLine.indexOf("Use");
expect(wrappedTitleLine.indexOf("countable")).toBe(labelColumn);
expect(metadataLine.indexOf("5.7/k")).toBe(labelColumn);
expect(actionErrorLine.indexOf("Action failed:")).toBe(labelColumn);
```

Also assert every visible line has `visibleWidth(line) <= suppliedWidth` at compact width.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run tests/overlay-rendering.test.ts tests/overlay.test.ts
```

Expected: failures because new badges still render and continuation/metadata lines start at the generic one-column body indent.

- [ ] **Step 3: Implement hanging-indent row rendering**

In `statsBody()`, keep the generic `append()` helper for dashboard content. Add a rule-specific helper that accepts prefix and content, wraps against `width - 1 - prefix.length`, and appends continuation lines with spaces matching prefix width:

```ts
const appendHanging = (prefix: string, content: string): { start: number; end: number } => {
  const available = Math.max(1, width - 1 - visibleWidth(prefix));
  const wrapped = wrapTextWithAnsi(content, available);
  const start = lines.length;
  const continuation = " ".repeat(visibleWidth(prefix));
  wrapped.forEach((line, index) => lines.push(` ${index === 0 ? prefix : continuation}${line}`));
  return { start, end: lines.length - 1 };
};
```

Use a six-column prefix (`"> [x] "`, `"  [ ] "`) for titles. Because modal body lines retain their existing one-column inset, tests compare continuation content to the first title's computed label column instead of a raw absolute string index. Render recurring metadata and focused action errors through the same helper using a six-space prefix and no hidden identifiers.

Delete the `new` branch from `ruleTrend()`. For a new rule, return no trend marker and build metadata from nonempty fields so spacing never doubles unpredictably:

```ts
private ruleTrend(rule: RuleAnalytics): string | undefined {
  if (rule.trend === "new") return undefined;
  if (rule.trend === "stable") return "→";
  const arrow = rule.trend === "improving" ? "↓" : "↑";
  const change = rule.changePercent === undefined ? "" : `${Math.abs(Math.round(rule.changePercent))}%`;
  return `${arrow}${change}`;
}
```

Replace aggregate copy with:

```ts
append(`↓ ${stats.trendCounts.improving} improving   ↑ ${stats.trendCounts.worsening} worsening   → ${stats.trendCounts.stable} stable`);
```

Do not change `RuleAnalytics`, `trendCounts`, sorting, or analytics computation.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run tests/overlay-rendering.test.ts tests/overlay.test.ts tests/analytics.test.ts
npm run typecheck
git diff --check
```

Expected: all pass; Stats contains no rendered new badge/count; focused-range scrolling still includes title plus metadata.

- [ ] **Step 5: Commit Task 1**

```bash
git add extensions/pi-fluency/overlay.ts tests/overlay-rendering.test.ts tests/overlay.test.ts
git commit -m "fix: polish Stats rule annotations"
```

---

### Task 2: Increase practice deadline and classify failures

**Files:**
- Modify: `extensions/pi-fluency/index.ts`
- Modify: `README.md`
- Test: `tests/extension.test.ts`
- Test: `tests/worker.test.ts`

**Interfaces:**
- Produces internal constant: `PRACTICE_CHECK_TIMEOUT_MS = 12_000`.
- Consumes: `ForegroundAnalysisOutcome["kind"]` from `FluencyWorker.analyzeForeground()`.
- Preserves: public command and persistence interfaces.

- [ ] **Step 1: Add failing deadline and copy tests**

Use fake timers and deferred analyzers through the public extension seam.

Add a test where analysis resolves after 6,100 ms but before 12,000 ms:

```ts
const input = harness.emitInput("I made an error that should still be checked.");
await vi.advanceTimersByTimeAsync(6_100);
analyzerResult.resolve(cleanResult);
await expect(input).resolves.toEqual({ action: "continue" });
expect(harness.notifications).not.toContainEqual(expect.objectContaining({
  message: expect.stringContaining("timed out"),
}));
```

Add a 12,100 ms timeout test expecting:

```text
Sent without practice check — analyzer timed out after 12 seconds.
```

Add outcome tests for:

```text
busy       → Sent without practice check — analyzer was busy for 12 seconds.
error      → Sent without practice check — analyzer failed.
shutdown   → Sent without practice check — analyzer stopped during reload or shutdown.
quarantine → Sent without practice check — analyzer unavailable; restart Pi to restore practice.
```

Keep the existing explicit user `s` assertion:

```text
Sent without practice check — analyzer cancelled.
```

Add policy-read rejection after successful provider analysis expecting:

```text
Sent without practice check — policy unavailable.
```

Where direct worker outcome injection is cleaner than forcing coordinator internals, type a fake `FluencyWorker` seam or use existing coordinator/deferred patterns; do not inspect private fields.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run tests/extension.test.ts tests/worker.test.ts
```

Expected: post-six-second success currently times out and all technical outcomes still collapse to one generic notice.

- [ ] **Step 3: Implement named deadline and exact classification**

Near input orchestration constants add:

```ts
const PRACTICE_CHECK_TIMEOUT_MS = 12_000;
```

Build the deadline as:

```ts
const foregroundDeadline = handlerStartedAt + PRACTICE_CHECK_TIMEOUT_MS;
```

Replace mutable generic copy with an outcome mapper:

```ts
function practiceFailureMessage(kind: Exclude<ForegroundAnalysisOutcome["kind"], "success">): string {
  switch (kind) {
    case "busy": return "Sent without practice check — analyzer was busy for 12 seconds.";
    case "timeout": return "Sent without practice check — analyzer timed out after 12 seconds.";
    case "error": return "Sent without practice check — analyzer failed.";
    case "shutdown": return "Sent without practice check — analyzer stopped during reload or shutdown.";
    case "quarantined": return "Sent without practice check — analyzer unavailable; restart Pi to restore practice.";
    case "cancelled": return "Sent without practice check — practice settings changed.";
  }
}
```

Record the mapped message when `analyzeForeground()` returns non-success. Keep explicit `send-unchecked` copy outside this mapper.

Separate policy phases from analyzer outcomes: an exception from initial, authorization, or post-analysis `getFreshPolicySnapshot()` sets the policy-unavailable message. Do not expose raw error text. Preserve analytics-disabled behavior and avoid background enqueue after consent withdrawal.

Update README practice latency copy from six to twelve seconds and state this is a maximum cap; successful checks proceed immediately and `s` bypasses checking.

- [ ] **Step 4: Verify GREEN and regression safety**

```bash
npx vitest run tests/extension.test.ts tests/worker.test.ts tests/coaching-overlay.test.ts
npm run check
git diff --check
```

Expected: all tests and typecheck pass; exact notices are covered; no schema fixtures change.

- [ ] **Step 5: Commit Task 2**

```bash
git add extensions/pi-fluency/index.ts README.md tests/extension.test.ts tests/worker.test.ts tests/coaching-overlay.test.ts
git commit -m "fix: allow slower practice checks"
```

---

## Final Review

- Run independent correctness and TUI reviews over the complete branch diff.
- Fix every confirmed blocker or important finding with public-seam regression coverage.
- Run fresh completion command:

```bash
npm run check && git diff --check && test -z "$(git status --short)"
```

- Do not touch, inspect, migrate, or clear real user history during verification.
