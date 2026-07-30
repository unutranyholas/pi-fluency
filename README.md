# Pi Fluency

Pi Fluency is a Pi extension that turns recurring English mistakes in human-authored prompts into private, keyboard-first coaching. It analyzes sanitized interactive prose after Pi settles, asks you to review each detected occurrence, and tracks accepted mistakes per 1,000 English words across projects and sessions.

## Privacy

Pi Fluency collects only `input` events with `source === "interactive"`. It excludes RPC/API input, extension-injected messages such as Ralph and subagent control prompts, slash commands, fenced and indented code, inline code, assistant messages, and tool output.

Before analysis it:

- strips terminal control sequences;
- removes code;
- redacts common API keys, tokens, secrets, passwords, private keys, JWTs, cloud credentials, and URL user-info credentials;
- hashes the sanitized prose for replay protection.

Language classification belongs to the selected analyzer model. English results create word-count observations; non-English results must contain no mistakes or demonstrated fixes and contribute nothing to analytics.

After explicit consent, Pi Fluency sends the selected provider:

- filtered, redacted prose;
- up to 500 newest eligible pending or accepted rules, represented by internal key, explanation, and ERRANT type;
- controlled ERRANT error types and context-scope choices for structured output.

Full prompts are never written to history. Local history stores prompt hashes, timestamps, local dates, English word counts, occurrence decisions, and bounded sanitized finding excerpts/corrections/explanations. An excerpt may equal an entire short sanitized prompt. Demonstrated-fix evidence is processed in memory but omitted from persisted events. Data goes only to the model provider selected during setup.

Global data lives under `~/.pi/agent/pi-fluency/`. The directory is restricted to mode `0700`; history and settings files use `0600`.

## Install

**Requires Pi 0.80.10 or newer.**

```sh
pi install npm:pi-fluency
```

Run `/reload` after installation.

For local development:

```sh
git clone https://github.com/unutranyholas/pi-fluency.git
cd pi-fluency
npm install
pi -e ./extensions/pi-fluency/index.ts
```

## First run

Run `/fluency`. Select an available low-cost analyzer model, review the provider disclosure, and accept consent. Analysis remains disabled unless setup completes. Provider credentials come from Pi's model registry.

## Review model

Each Inbox card represents every currently pending occurrence of one concrete rule.

- **Accept** confirms only the current pending batch. Accepted occurrences enter analytics. A later recurrence opens the rule in Inbox again.
- **Dismiss** rejects only the current pending batch. It does not suppress future recurrence and does not enter the mistake-rate numerator.
- **Ignore** persistently hides an exact rule or ERRANT category. Hidden pending occurrences remain stored and return when restored. Already accepted history remains accepted.
- **Clear** removes coaching and analytics history while preserving settings, model choice, and consent.

Rules use stable namespaced keys and full ERRANT types such as `M:DET`, `U:PUNCT`, and `R:VERB:FORM`. Internal keys and ERRANT codes are not shown in coaching or Stats UI.

## Toolbar

Normal toolbar example:

```text
󰇮 12  󰌵 6  ▆▄▃▂▁▂▂ 8.4/k
```

| Part | Meaning |
| --- | --- |
| `󰇮 12` | 12 visible pending occurrences; `󰇰` means zero |
| `󰌵 6` | 6 recurring rule-explanation groups with accepted occurrences in the trailing seven days |
| `▆▄▃▂▁▂▂` | Seven rolling seven-day accepted-mistake rates |
| `8.4/k` | Latest accepted mistakes per 1,000 English words |

Counts are real and unclamped. A missing denominator renders `—/k`; missing sparkline points render `·`. Startup shows a loading-shaped toolbar. Stable errors are bounded to:

```text
󰅙 ERR auth
󰅙 ERR model
󰅙 ERR analyze
󰅙 ERR store
󰅙 ERR migrate
```

Full sanitized error detail appears in notifications. `/fluency status` reports state, model, queue, drops, and storage warning count. Stock Pi receives the complete toolbar text. Powerbar receives the leading Nerd Font icon separately to avoid duplication. With Powerbar installed, add **Pi Fluency** through `/extension-settings`.

## Commands and keyboard controls

`Ctrl+Shift+L` opens Inbox when configured.

| Command | Action |
| --- | --- |
| `/fluency` | Run setup when unconfigured; otherwise open Inbox |
| `/fluency stats` | Open local Stats directly, including while paused or model-offline |
| `/fluency pause` | Stop analysis and hide status |
| `/fluency resume` | Resume a valid consented configuration |
| `/fluency status` | Show state, model, queue, drops, and storage warnings |
| `/fluency model` | Select another analyzer model and review provider disclosure |
| `/fluency clear` | Confirm, then remove coaching and analytics history |

Inside the overlay:

- Left/Right changes cards.
- Up/Down, `j`/`k`, and Page Up/Down scroll.
- `a` accepts the current Inbox batch; `l` remains a compatibility alias.
- `d` dismisses the current Inbox batch.
- `i` ignores an exact rule or ERRANT category.
- `u` restores every ignore affecting an item in Ignored.
- Tab cycles Inbox, Accepted, Ignored, and Stats.
- Esc closes.

Actions auto-advance to the next card. Stats is read-only. Compact diffs use `└─` for replacements, strikethrough for deletions, and underline for insertions.

## Analytics and Stats

For a period `P`:

```text
accepted mistake rate(P) = accepted occurrences in P / English words in P × 1000
```

Every analyzer-classified English prompt contributes words, including prompts with zero findings. Pending, dismissed, hidden-unaccepted, and non-English occurrences do not enter the numerator.

Stats covers 30 local calendar days and shows:

- 30-day accepted rate, English words, accepted, dismissed, and visible pending totals;
- a single aggregate count for one-off accepted mistakes in the period;
- review coverage: `(accepted + dismissed) / (accepted + dismissed + visible pending)`;
- active trailing-seven-day recurring rules;
- rolling seven-day toolbar trend;
- recurring-rule rates, sparklines, and `improving`, `worsening`, `stable`, or `new` trends.

A rule becomes recurring after at least two accepted occurrences across retained history. One-offs remain part of accepted totals and rates, but do not clutter the toolbar count, Concrete rules list, or trend totals. Rule trends compare adjacent 30-day windows. Improving/worsening requires both at least 20% relative change and at least 0.5 mistakes per 1,000 words absolute change. Rules are grouped and displayed by human explanation, never by internal key or broad category.

## Storage and migration

`settings.json`, `history.jsonl`, and the private clear-generation marker are shared globally across Pi projects and sessions. Analyzer responses and current settings use schema v3. History uses strict schema v4 events with deterministic occurrence IDs. Compaction:

- retains every pending occurrence regardless of age;
- retains 365 local calendar days of reviewed observations and occurrences;
- preserves hashes referenced by retained observations;
- writes state-free schema-v4 snapshots under an atomic cross-process lock.

History schema v4 is a clean break. Non-empty v1, v2, or v3 history is not interpreted, normalized, or rewritten. Pi Fluency reports `ERR migrate` and blocks history mutations until confirmed clear. There is no automatic migration or backup. Current schema-v3 settings, provider choice, and consent remain intact.

### Safe history reset

Direct `history.jsonl` edits are unsupported, especially while the extension is running. To recover from old, polluted, or unwanted history:

1. Run `/reload` after installing the updated extension.
2. Run `/fluency clear`.
3. Confirm the prompt.
4. Verify `/fluency stats` is empty and settings/model/consent remain configured.

Pi Fluency adopts the English error taxonomy from the MIT-licensed [ERRANT toolkit](https://github.com/chrisjbryant/errant) and its [ACL 2017 paper](https://aclanthology.org/P17-1074/). It does not bundle ERRANT, Python, spaCy, language models, or learner corpora.

## Development

```sh
npm install
npm run check
pi -e ./extensions/pi-fluency/index.ts
```

Automated tests always use temporary storage roots and never touch `~/.pi/agent/pi-fluency/`.

## Known limitations

The overlay is available only in interactive TUI mode. Pi has no native low-priority scheduler, so Pi Fluency queues bounded work and starts analysis only after the main agent settles and Pi reports idle. Redaction is defense in depth, not a substitute for avoiding secrets in prompts.
