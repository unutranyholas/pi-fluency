# Stats Polish and Practice Timeout Design

## Goal

Remove misleading `new` annotations from concrete rules, align wrapped rule content under its label, and make pre-send practice failures both less frequent and diagnostically precise.

## Confirmed Root Cause

Practice currently applies one six-second absolute deadline to policy reads, coordinator waiting, provider analysis, and result revalidation. The configured `openai-codex/gpt-5.6-terra` model returned a minimal strict-JSON response in 6.82 seconds during an isolated extension-disabled probe, while a second realistic grammar probe returned in 4.87 seconds. Six seconds therefore falls inside ordinary provider latency variance.

The warning cannot identify the historical incident precisely because all non-quarantine foreground outcomes and caught failures collapse into:

```text
Sent without practice check — analyzer busy/timed out/failed.
```

The user will switch the analyzer to Luna. The extension will still increase the maximum deadline so transient latency does not immediately defeat practice mode.

## Practice Deadline and Failure Copy

Set the total foreground practice deadline to 12 seconds. This is a maximum cap, not a mandatory delay: successful checks proceed immediately. The existing `s` action remains available during checking to send immediately without a check.

Preserve fail-open behavior. A technical failure sends the prompt and may enqueue ordinary background analysis under existing authorization fences.

Map foreground outcomes to specific bounded notices:

- `busy`: `Sent without practice check — analyzer was busy for 12 seconds.`
- `timeout`: `Sent without practice check — analyzer timed out after 12 seconds.`
- `error`: `Sent without practice check — analyzer failed.`
- `cancelled`: preserve explicit user-cancellation copy when the user presses `s`; policy-change cancellation uses `Sent without practice check — practice settings changed.`
- `shutdown`: `Sent without practice check — analyzer stopped during reload or shutdown.`
- `quarantined`: preserve restart-required notice.
- initial, authorization, or post-analysis policy-read failures retain the existing policy-unavailable notice.

Provider error details remain hidden from the notification because they may be noisy or sensitive. Internal tests assert outcome classification rather than provider prose.

## Stats Rule Presentation

Remove the `new` concept from the Stats presentation only:

- Remove `✦ new` from each rule metadata line.
- Remove the aggregate `✦ N new` count from the Concrete rules summary.
- Keep analytics trend classification unchanged for sorting and future calculations.
- Do not add durable “seen” state or schema fields.

Improving, worsening, and stable indicators remain.

## Hanging Indent

A focused rule renders with a six-column control prefix:

```text
> [x] Use an article before a singular
      countable noun.
      5.7/k  ···▁▆██
```

Rules:

- First title line starts with focus marker, space, checkbox, and space.
- Wrapped title continuation lines begin with six spaces.
- Rate/trend/sparkline metadata begins with six spaces.
- Unfocused rows reserve the same six columns so labels never shift horizontally when focus moves.
- Action-error continuation for the focused row uses the same hanging indent.
- Width calculations subtract the prefix before wrapping label and metadata content.
- Very narrow terminals retain valid bounded lines; prefix may occupy most of the row, but output never exceeds supplied width.

## Data and Privacy

No analyzer, settings, history, or practice schema changes. No durable “seen” tracking. No prompt content is added to notifications or Stats rendering. Existing authorization, fail-open, editor preservation, and conditional persistence behavior remain unchanged.

## Tests

Public-seam coverage must prove:

1. A foreground request may resolve between six and twelve seconds without fail-open.
2. The request times out at twelve seconds.
3. Busy, timeout, error, shutdown, and quarantine outcomes produce distinct notices.
4. User `s` cancellation retains its explicit cancellation notice.
5. No rendered Stats output contains `✦ new` or an aggregate new count.
6. Wrapped focused and unfocused labels, metadata, and action errors align at column seven.
7. Narrow output remains within terminal width.
8. Full typecheck and test suite pass without schema changes.
