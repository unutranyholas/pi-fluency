# Pi Fluency

**English writing analytics for [Pi](https://github.com/earendil-works/pi).**

Pi Fluency analyzes human-authored prompts, lets you review possible English mistakes, and tracks recurring patterns over time. It is an analytical tool—not an English teacher—and every finding stays provisional until you review it.

- Reviews only interactive prompts you write
- Groups repeated findings into concrete recurring patterns
- Tracks accepted mistakes per 1,000 English words
- Keeps one-off mistakes out of recurring-pattern counts
- Works across Pi projects and sessions

## See the inbox

Pi Fluency opens as a keyboard-first TUI inside Pi. Each card groups currently pending occurrences of one possible mistake:

```text
╭──────────────────────────────────────────────────────────────────────╮
│ Pi Fluency · Inbox                 Pending 3 · accepted 0 · ← 1 / 1 →│
│ ──────────────────────────────────────────────────────────────────── │
│ › I want to have an parallel agent with a deliberately long          │
│                  └─ a                                                │
│   context.                                                           │
│                                                                      │
│ Use “a” before a consonant sound.                                    │
│ ──────────────────────────────────────────────────────────────────── │
│ ←→ card  ↑↓/jk scroll  a accept  d dismiss                           │
│ i ignore  tab view  esc close                                        │
╰──────────────────────────────────────────────────────────────────────╯
```

- **Accept** confirms current pending occurrences and includes them in analytics.
- **Dismiss** rejects current batch without suppressing future recurrence.
- **Ignore** hides exact pattern or mistake category until restored.
- **Tab** cycles through Inbox, Accepted, Ignored, and Stats views.

## Install and start

Requires Pi 0.80.10 or newer.

```sh
pi install npm:pi-fluency
```

Run `/reload`, then `/fluency`. Choose an available analysis model and confirm provider disclosure. Analysis remains off until setup completes.

Useful commands:

| Command | Action |
| --- | --- |
| `/fluency` | Set up Pi Fluency or open Inbox |
| `/fluency stats` | Open 30-day analytics |
| `/fluency pause` | Pause analysis and hide toolbar status |
| `/fluency resume` | Resume analysis |
| `/fluency model` | Change analysis model |
| `/fluency status` | Show model, queue, and storage status |
| `/fluency clear` | Confirm, then clear coaching and analytics history |

`Ctrl+Shift+L` opens Inbox after setup.

## What it measures

Pi Fluency counts only findings you accept. Every analyzer-classified English prompt contributes to word totals, including prompts with no findings.

```text
accepted mistake rate = accepted occurrences / English words × 1000
```

Stats covers trailing 30 local calendar days. It shows accepted rate, review coverage, one-off total, recurring patterns, and trends. Pattern list is sorted by accepted occurrence count. Pattern becomes recurring after at least two accepted occurrences across retained history; one-offs remain in overall accepted totals and rate but stay out of recurring-pattern list and toolbar count.

Toolbar summarizes current activity and accepted-mistake trends:

```text
📥 12  💡 6  ▆▄▃▂▁▂▂  8.4/k
```

| Part | Meaning |
| --- | --- |
| `📥 12` | 12 visible pending occurrences |
| `💡 6` | 6 recurring patterns active during trailing 7 days |
| `▆▄▃▂▁▂▂` | Seven rolling accepted-mistake rates |
| `8.4/k` | Latest accepted mistakes per 1,000 English words |

## Data and limitations

Pi already sends your prompts to selected main model. When enabled, Pi Fluency additionally sends eligible, filtered prompt prose to analysis model you choose during setup. It excludes assistant messages, tool output, slash commands, injected extension input, and code; it also redacts common credentials before analysis.

Local analytics live under `~/.pi/agent/pi-fluency/`. History contains hashes, dates, word counts, review decisions, and bounded finding excerpts—not complete prompts. Storage is shared across Pi projects and sessions.

Model findings can be incomplete or wrong. Accept only findings you agree with. Pi Fluency measures reviewed writing patterns; it does not assess fluency, guarantee improvement, or replace human instruction.

## Project

Product idea and product decisions are by Ihar Trafimovich. All code, tests, and documentation were written by AI.

Pi Fluency uses the English error taxonomy from the MIT-licensed [ERRANT toolkit](https://github.com/chrisjbryant/errant) and its [ACL 2017 paper](https://aclanthology.org/P17-1074/). It does not bundle ERRANT, Python, spaCy, language models, or learner corpora.

For local development:

```sh
git clone https://github.com/unutranyholas/pi-fluency.git
cd pi-fluency
npm install
npm run check
pi -e ./extensions/pi-fluency/index.ts
```

Automated tests use temporary storage and never touch `~/.pi/agent/pi-fluency/`.

[Report an issue](https://github.com/unutranyholas/pi-fluency/issues) · [MIT License](LICENSE)
