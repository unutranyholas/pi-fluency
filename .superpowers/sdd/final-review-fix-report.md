# Final Review Fix Report

Status: DONE

## Red evidence

Current regression tests were copied onto clean `HEAD` source in `/tmp` and run with:

`npx vitest run tests/collector.test.ts tests/analyzer.test.ts tests/worker.test.ts tests/store.test.ts tests/extension.test.ts tests/overlay.test.ts`

Expected red result: exit 1, 22 failed / 85 passed. Failures directly covered missing credential redaction, analyzer caps/control sanitization/evidence verification, retained numeric status, provider consent, auth queue pause, merge-safe updates, and overlay abort cleanup.

## Findings fixed

1. **Provider-specific consent**
   - `extensions/pi-fluency/setup.ts`: shared selection/disclosure supports initial setup and model change; approved change records injected fresh timestamp through lock-scoped patch.
   - `extensions/pi-fluency/index.ts`: `/fluency model` declines without mutation, shuts stale worker only after approval, then clears/recomputes status.
   - Evidence: provider decline/approval tests in `tests/extension.test.ts`.

2. **Credential sanitization**
   - `extensions/pi-fluency/collector.ts`: redacts bearer auth, GitHub tokens, AWS access IDs, JWT shapes, whitespace keyword forms, and external PEM private keys before normalization/hash.
   - Evidence: 10 new credential/hash regression cases in `tests/collector.test.ts`; differing secrets normalize to identical placeholder/hash and secret bytes are absent.

3. **Demonstrated-fix evidence verification**
   - `extensions/pi-fluency/analyzer.ts`: accepts fixes only for active known pattern keys with exact non-empty evidence substring in sanitized current prose.
   - Evidence: hallucinated and unknown evidence test in `tests/analyzer.test.ts`.

4. **Pause queue on missing credentials/model**
   - `extensions/pi-fluency/analyzer.ts`: typed `AnalyzerConfigurationError` for auth resolution and unavailable model construction.
   - `extensions/pi-fluency/worker.ts`: configuration errors bypass retry, restore current prompt at queue front, report once, and stop drain; later drain retries retained queue.
   - Evidence: worker recovery test and extension `agent_settled` recovery integration test.

5. **Untrusted model bounds and terminal safety**
   - `extensions/pi-fluency/analyzer.ts`: caps mistakes at 20, fixes at 25, deduplicated class IDs at 4; strips ANSI/C0/C1 from accepted model strings while retaining confidence/schema/quote validation.
   - `extensions/pi-fluency/store.ts`: defense-in-depth strips terminal bytes before persistence.
   - Evidence: oversized output, control injection, and persistence/replay tests in analyzer/store suites.

6. **Merge-safe cross-process settings**
   - `extensions/pi-fluency/store.ts`: adds lock-scoped `updateSettings`; refreshes disk under global lock, applies intended patch/mutator, and retains unique temp writes. Public stale full-object save derives changed fields from caller snapshot.
   - `extensions/pi-fluency/index.ts`, `setup.ts`: pause/resume/model/setup migrated to patches. Ignore operations use refreshed mutators.
   - Evidence: two-instance concurrent ignore plus stale pause/model/consent test in `tests/store.test.ts`.

7. **Overlay shutdown cleanup**
   - `extensions/pi-fluency/overlay.ts`: default inbox accepts `AbortSignal`; abort disposes component, calls `done`, and removes listener.
   - `extensions/pi-fluency/index.ts`: owns overlay controller/promise, coalesces duplicate opens, aborts and awaits overlay for shutdown, clears references, blocks post-shutdown opens.
   - Evidence: default overlay abort/dispose test plus all five shutdown reason integration cases.

8. **Preserve numeric status**
   - `extensions/pi-fluency/index.ts`: publishes loading only without any latest analysis; later enqueue retains existing stock footer and Powerbar numeric status.
   - Evidence: latest numeric status regression in `tests/extension.test.ts`; first-analysis behavior remains covered.

9. **Peer range**
   - Intentionally unchanged: `package.json` peer remains `>=0.80.10`.

## Green evidence

- Focused: `npm test -- --run tests/overlay.test.ts tests/analyzer.test.ts tests/collector.test.ts tests/worker.test.ts tests/store.test.ts tests/extension.test.ts` — 6 files, 107 tests passed.
- Typecheck: `npm run typecheck` — passed.
- Full suite: `npm test` — 9 files, 128 tests passed.
- Diff validation: `git diff --check` — passed.
- Pi API inspection: verified `ExtensionUIContext.custom<T>` factory/done/disposable contract in installed `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`.

## Residual risks

None known. Conservative credential patterns may redact some prose-like token shapes by design (false-negative minimization requirement).

---

# Inline Stats Final-Review Fixes

Status: DONE

## Findings fixed

1. **Zero-baseline daily chart scaling**
   - `dailyRateSparkline` now uses a dedicated zero-to-period-maximum renderer.
   - Existing public `renderSparkline` remains unchanged for toolbar and per-rule min-max charts.
   - Public analytics regression proves 10/k renders half-height beside 20/k maximum, word-bearing zero renders `▁`, and missing days render `·`.

2. **Compact, authoritative Stats practice status**
   - Stats footer now always states whether selected rules are checked before send.
   - Copy distinguishes active, master-off, session-snoozed, global-snoozed, and combined snooze states using `PracticeOverlayState`.
   - Compact terminal budget retains selected checkbox, status, Space action, and close action.
   - README now says first Space atomically records preflight consent, enables practice, and selects focused rule without a separate prompt.

3. **Bounded sanitized mutation errors**
   - Overlay error sanitization retains C0/C1 replacement, then caps message at 200 characters before wrapping/rendering.
   - Regression submits a 2,000-character controlled mutation error and proves sanitized prefix plus truncation marker render while tail does not.

## TDD evidence

### RED: daily scaling

Command:

```bash
npx vitest run tests/analytics.test.ts
```

Result: expected failure. 1 file failed; 1 failed / 27 passed. Unequal nonzero daily rates rendered `██▁` under period-minimum subtraction instead of expected `▅█▁` zero-baseline scaling.

### RED: Stats status rendering

Command:

```bash
npx vitest run tests/overlay.test.ts tests/overlay-rendering.test.ts
```

Result: expected failure. Overlay action tests passed; rendering file had 5 failures / 20 passes. Active, master-off, session-snoozed, global-snoozed, and compact visibility cases could not find status copy.

### GREEN: focused public seams

Command:

```bash
npx vitest run tests/analytics.test.ts tests/overlay.test.ts tests/overlay-rendering.test.ts
```

Result: passed. 3 files passed; 97 tests passed.

### GREEN: full project check

Command:

```bash
npm run check
```

Result: passed. `tsc --noEmit` passed; 25 files and 438 tests passed.

### GREEN: diff validation

Command:

```bash
git diff --check
```

Result: passed with no whitespace errors.

## Changed files

- `README.md`
- `extensions/pi-fluency/analytics.ts`
- `extensions/pi-fluency/overlay.ts`
- `tests/analytics.test.ts`
- `tests/overlay-rendering.test.ts`
- `tests/overlay.test.ts`
- `.superpowers/sdd/final-review-fix-report.md`

## Residual risks

None known. No persistence schemas, history data, coaching policy, toolbar scaling, or per-rule scaling changed.
