# Pi Fluency

**English writing analytics for [Pi](https://github.com/earendil-works/pi).**

Pi Fluency analyzes human-authored prompts, lets you review possible English mistakes, and tracks recurring patterns over time. It is an analytical tool—not an English teacher—and every finding stays provisional until you review it.

- Reviews only interactive prompts you write
- Groups repeated findings into concrete recurring patterns
- Offers optional submit-time practice for recurring rules you select
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

Run `/reload`, then `/fluency`. Choose an available analysis model and confirm provider disclosure for background analytics. Analysis remains off until setup completes. Optional preflight practice stays off until first Space selection atomically records preflight consent, enables practice, and selects focused rule.

Useful commands:

| Command | Action |
| --- | --- |
| `/fluency` | Set up Pi Fluency or open Inbox |
| `/fluency stats` | Open 30-day analytics and choose recurring rules |
| `/fluency practice` | Open Stats |
| `/fluency practice on` / `off` | Enable or bypass selected-rule practice |
| `/fluency practice resume` | End current session and five-hour snoozes |
| `/fluency practice reset` | Confirm, then clear practice selections and consent |
| `/fluency pause` | Pause analysis and hide toolbar status |
| `/fluency resume` | Resume analysis |
| `/fluency model` | Change analysis model |
| `/fluency status` | Show model, queue, storage, and practice status |
| `/fluency clear` | Confirm, then clear coaching and analytics history; preserve practice selections |

`Ctrl+Shift+L` opens Inbox after setup.

## Practice selected rules

Practice is an optional analytical aid, not comprehensive grammar checking, automatic correction, or English instruction. Stats shows recurring rules as inline `[ ]` or `[x]` rows. First rule starts focused; use Up/Down or `j`/`k` to move focus and keep focused row in view, then press Space to toggle it. First Space records preflight consent, enables practice, and selects focused rule atomically; no separate consent prompt opens. This consent means eligible sanitized prompt prose may reach configured Fluency model before main request proceeds, including a draft you later keep instead of sending.

For idle, text-only interactive prompts, Pi Fluency checks selected rules at submit time. This sends full sanitized prose from eligible prompt to analysis provider and can add provider latency, bounded to one attempt within about six seconds. Editor keeps exact text Pi Fluency received while check runs. Clean result proceeds normally. Match opens checkpoint without rewriting text:

- **Edit** or **Esc** blocks submission and leaves received text in editor.
- **Send once** proceeds once and keeps practice active for later prompts.
- **Snooze session** proceeds once and bypasses checks for current conversation session, including reload or resume of same session file.
- **Snooze 5 hours** proceeds once and bypasses checks across Pi sessions until deadline.
- While checking, **Send unchecked** cancels bounded check and proceeds; **Esc** returns to Edit.

Use `/fluency practice resume` to end either snooze. Technical errors, busy or timed-out analysis fail open and attempt to send unchecked. If editor cannot be cleared safely, Pi Fluency does not send and leaves draft visible. Adapter that ignores cancellation is quarantined process-locally: later prompts send unchecked without growing analysis queue until call settles or Pi process restarts.

Successful preflight result is reused for normal analytics. Edit/Esc attempt adds no Pi Fluency history; later edited submission is checked again. Practice selections are separate from history, so `/fluency clear` preserves them. Ignoring selected rule pauses matching practice until rule is restored.

## What it measures

Pi Fluency counts only findings you accept. Every analyzer-classified English prompt contributes to word totals, including prompts with no findings.

```text
accepted mistake rate = accepted occurrences / English words × 1000
```

Stats covers trailing 30 local calendar days. Its normalized chart always has 30 positions, labeled from `30 days ago` through `today`; `·` means no English words were recorded for that local day. It also shows accepted rate, review coverage, one-off total, recurring patterns, and trends. Pattern list is sorted by accepted occurrence count. Pattern becomes recurring after accepted findings appear in at least two distinct prompts across retained history; one-offs remain in overall accepted totals and rate but stay out of recurring-pattern list and toolbar count.

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

Preflight does not run for image-bearing submissions, slash commands, code-only input, RPC or extension-injected input, or active-stream `steer` / `followUp` input. Those boundaries avoid attachment loss and agent-control delays; eligible prompts may still use background analytics. Practice checks only selected concrete rules, so no checkpoint means neither proof that text is correct nor comprehensive analysis.

Input-handler order limits draft provenance. Extensions running before Pi Fluency can alter text Pi Fluency receives and can therefore alter text restored for Edit. Extensions running after Pi Fluency can alter or intercept text Pi Fluency allowed, so analyzed text is not guaranteed to equal final sent text. Place text-transforming or intercepting extensions compatibly; Pi Fluency cannot enforce original editor bytes or final send order.

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
