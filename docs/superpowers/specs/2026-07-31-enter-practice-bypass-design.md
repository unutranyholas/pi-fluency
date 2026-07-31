# Enter Practice Bypass Design

## Goal

Make the pre-send practice checkpoint follow normal terminal confirmation conventions: Enter proceeds, Escape edits, and slow but healthy analyzer calls receive enough time to finish.

## Confirmed Context

The configured analyzer is `openai-codex/gpt-5.6-luna`. Two isolated extension-disabled grammar probes completed in 5.50 and 5.31 seconds, but production Fluency requests include full analyzer instructions and known-rule context. The current 12-second total cap has still timed out during real use.

The existing background analyzer already uses a 30-second timeout. Foreground practice will use the same maximum duration while retaining immediate user bypass.

## Checking State

While analysis is in progress:

```text
Checking selected fluency rules…

Enter  Send unchecked
Esc    Edit
```

Behavior:

- Enter or configured `tui.select.confirm` finishes with `send-unchecked`.
- Escape or configured `tui.select.cancel` finishes with `edit`.
- Remove the `s` checking shortcut.
- Enter is consumed by the overlay. It resolves the intercepted original input exactly once; it does not insert a newline or create a second submission.
- Maximum total foreground duration is 30 seconds, including store acquisition, policy reads, coordinator wait, provider analysis, post-analysis validation, and 100 ms abort grace.
- Successful checks proceed as soon as analysis finishes; 30 seconds is a cap, not a fixed delay.

## Matched State

After findings arrive, initial action focus moves from Edit to Send once:

```text
  Edit
› Send once
  Snooze session
  Snooze 5 hours

Enter confirm   Esc edit
```

Behavior:

- Enter or configured confirm activates focused action.
- Up/Down and `j`/`k` continue moving action focus.
- Escape always edits.
- Remove direct `s` Send-once shortcut.
- Existing `e`, `t`, and `5` shortcuts may remain because they do not conflict with confirmation semantics.
- Saving state continues freezing input.

This gives Enter one consistent meaning: proceed with currently visible default/selection. Escape consistently means return to editing.

## Timeout and Failure Copy

Change total cap from 12 to 30 seconds. Reserve 100 ms inside cap for abort settlement, so coordinator/provider deadline is 29.9 seconds.

Update bounded notices:

- busy: `Sent without practice check — analyzer was busy for 30 seconds.`
- timeout: `Sent without practice check — analyzer timed out after 30 seconds.`

Other exact notices remain unchanged. README describes Enter bypass and maximum 30-second cap.

## Safety and Scope

Preserve:

- exact editor-text retention and single-send behavior
- fail-open behavior
- shutdown distinction
- authorization and conditional persistence fences
- background analysis behavior
- snooze semantics
- analyzer/settings/history/practice schemas

No new setting or configurable timeout. No real history access in tests.

## Tests

Public component and extension tests prove:

1. Checking Enter sends unchecked exactly once and clears editor through existing handler flow.
2. Checking `s` does nothing.
3. Checking Escape still edits.
4. Matched state starts on Send once.
5. Matched Enter sends once.
6. Arrow navigation followed by Enter confirms Edit or either snooze.
7. Matched `s` does nothing.
8. A request remains active after 12 seconds and can succeed before 30 seconds.
9. Abort-ignoring analysis fails open by exactly 30 seconds, including 100 ms grace.
10. Busy/timeout notices say 30 seconds.
11. Full typecheck and test suite pass with no schema changes.
