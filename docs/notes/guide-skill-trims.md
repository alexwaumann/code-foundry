# Trimmed entry, help and pages skills (2026-11-06)

Target reader: Opus 5.5 at medium effort. Sonnet 5.5 runs only as a worker, so it does not decide
the gate. Plugin is untouched; orchestrate and Ember are a later PR.

**Users need a daemon restart**: skill files are written at daemon start.

## What changed

| Rendered body | Before | After | Budget |
|---|---|---|---|
| `code-foundry` | 6,438 | 5,165 | 6,800 to 5,500 |
| `code-foundry-help` | 7,586 | 5,179 | 7,900 to 5,500 |
| `code-foundry-pages` | 10,093 | 8,240 | 10,600 to 8,700 |

At 2.7 bytes a token, help is about 1,920 tokens (audit target 1,700) and pages about 3,050 (2,800).
Both stop short because the rule rows pin markers there, below.

- **Entry**: short routing rows. "Showing things" moved to pages. New row for a thread's model,
  effort and mode. "What changed" split from the row of thread facts. "In place" became Project
  folder, as the composer and guide say.
- **Help**: "Reading the source" is now `reference/reading-the-source.md`, word for word.
  "Showing things in the app" is 3 bullets. Its hand-written `cf:theme` protocol went: every page
  loads `bridge.js`, which does it, and `docs/THEMES.md` still names the message.
- **Pages**: one React skeleton. New `reference/errors-and-limits.md` holds the error table and
  limits. The plain skeleton's job goes to `examples.md`, which already had one. The mockup
  paragraph points at `react.md`, which already had it. The wake section is one line.
- **Cut**: "Skills never run commands themselves", "read these instead of answering from memory",
  `/cost` and "never grep ~/.claude" from the entry's rows.
- `pages_test.go` now finds the error table in the reference. `commands_capabilities.go` names the
  new path. Two rule rows were added for `reading-the-source.md`; none was removed or loosened.

## Asked for, and not done as asked

- **The reply-length lines stay.** Both were cut, then restored, and the gate cannot see why.
  Mean length of the final answer on Opus, 3 runs each:

  | Task | Before | Line cut | Line back |
  |---|---|---|---|
  | `t8` (theme) | 735 | 1,585 | 870 |
  | `t5` (page board) | 541 | 1,059 | 484 |
  | `p6` (chart) | 617 | 596 | 435 |

  Every other task held. With the line gone, someone who asked for a quieter sidebar got a table of
  hex values. Verbs and routing stayed perfect throughout.
- **"Never tell the user skill or command names" stays in the entry as a clause.** The sentence is
  gone, but `rules_test.go` pins it there. `ThreadPrompt` also says it, so moving the row and
  cutting the clause is a decision for whoever owns the rule.
- **The page and wake rules have one home for their detail, not for their markers.** `rules_test.go`
  pins `/cf/theme.css`, `/cf/bridge.js` and "sizes its card" in entry and help, and the wake markers
  in entry and pages. So each pointer carries them. The `--cf-*` list lives only in pages, the wake
  flags in full only in the entry. No row was edited to get there.
- **`/model` stays**: pinned in the entry, and useful in the new row.

Rules that look unnecessary for Opus 5.5, left in place: the two above, and the entry's "never the
Mac's processes".

## Result

Opus 5.5, medium, Claude Code 2.1.316, 3 runs per task, 0 invalid. `make guide-eval-compare`: PASS.
Before side: `after-opus-index-5b95e4064`, rescored.

| 18 tasks | Before | After |
|---|---|---|
| Runs | 54 | 54 |
| Skill loaded | 45/45 | 45/45 |
| Correct verb | 54/54 | 54/54 |
| Guidance tokens per run | 6,770 | 6,142 (-628) |
| Failed CLI calls | 12 | 13 |
| Help hops | 36 | 36 |
| Monitor or Cron fetches | 2 | 2 |
| Cost in the runs | $14.39 | $14.29 |

With `s1` on both sides (19 tasks, 57 runs): 57/57 verbs, 6,654 to 6,025 (-629).

**Build**: main has moved since the before report only in `docs/ARCHITECTURE.md`, a note and the
scorer. None of it is embedded, so nothing a model reads differs but this PR.

**After report, for the next PR's before side:**
`~/.cache/code-foundry/guide-eval/after-opus-trims-33e647bc8/`. 16 tasks ran on `803a7cd2c`; `t5`, `t8`
and `p6` ran on `33e647bc8`. The only difference is the two restored lines, and those tasks are
the only ones that load them. `after-opus-trims-33e647bc8-18` is the same without `s1`.

### How far to trust -628

Not far. `t5` alone is most of it, and that task swings. The figures, for 54 runs unless stated:

| Scoring | Fall per run |
|---|---|
| Final report, this PR's scorer | 628 |
| Without `t5` (51 runs) | 330 |
| Without `t5`, `t8`, `p6` (45 runs, one build) | 307 |
| Final report, the old scorer | 136 |
| First full report (lines cut), old scorer | 327 |

The old scorer's 136 sits under the 170 floor. One run explains it, next section. The 307 is the
number to quote: it holds on any scorer and clears the floor. The floor itself was measured on 11
light tasks, so it says nothing about `t5`. Sizes have no noise: 471 tokens off each entry load,
about 890 off help, 690 off pages.

### The scorer

Bash sets an output over 30,000 characters aside and returns a 2 KB preview, and the scorer counted
the preview. Every `t5` run cats 30 to 47 KB of references, so a read of 37,700 bytes scored 2,272.
One rerun came in at 29,900, under the limit, and scored whole: 15,797 tokens against about
6,300 for the others, or 189 on the mean, which is all of the miss above.

Counting the full size was tried and was wrong: `t1` rose 5,767, because a 50 KB `settings get` dump
it never read counted as guidance. Now a set-aside output counts as the preview plus what the run
reads back from that file. **Older reports need `score.py report` before a comparison.** Both sides
here were rescored, which is why before reads 6,770 and not 5,986.

### Hops and wrong turns

Help hops are level in total, but they moved:

| Task | Help hops | Note |
|---|---|---|
| `t9` | 2 to 1 | Better. See below |
| `p7` | 6 to 3 | Better. 3 CLI calls to 2: the row gives the verb, no index grep |
| `t4` | 0 to 3 | Worse, and unexplained: the row's flags did not change. `p2`, `p3` always had this hop. 292 tokens |
| `t8` | 8 to 11 | Worse, with capabilities calls 3 to 8 |

- **`t9`**: the 2 hops #591 could not explain were `view.panel.file --help`, checking a file that does
  not exist. The row now says a missing file is made on save, and one run still looked.
  Capabilities calls rose 1 to 4, each after "no app window is open", which the eval's no-window
  setup causes. The cut of "If refused, tell the user why" may have added to that. Tokens net -58.
- **`t8`** is the one task that got worse: 6 of 6 after runs reach for `--group rendering` (1 of 3
  before), about 1,100 to 2,400 tokens more. The cause is a guess: the entry no longer names `/cf/theme.css`'s
  variables, so it hunts for the live values. Its answers did not suffer.
- **`p5`**: 2 new failed calls, `thread search "--shout"`, which needs the term after `--`. Each
  recovered at once.
- **Dropped hints**: no loss. `t3` used `usage.show` 3 of 3. `p5` found the seed thread 3 of 3 and
  looked in `~/.claude/projects`' memory folder on all 3 runs, as the before side also did.

### New references

`errors-and-limits.md` was read by all 6 `t5` runs, `examples.md` by all 6 `p6` runs and
`reference/scopes.md` by all 3 `s1` runs. `reading-the-source.md`: 2 of 6 `t8` runs named it. **No
task asks how the app works inside**, so routing to it is unmeasured.

### The new task

`s1` asks for a rule across a workspace, in a thread that has one. It reached the workspace folder
and never `memory add`, 3 of 3 on both sides (`avoid` fails a run that does). Before 4,568, after
3,912. All 3 after runs said a running thread picks it up at its next start. `ThreadPrompt` already
routes this, so `s1` mostly proves the reference still answers "when".

## Reading the runs

Read: round 1 transcripts of `t1`, `t3`, `t4`, `t5`, `t8`, `t9`, `p5`, `p6`, `p7`, `p8`, `s1`; the final answers of
`t4`, `t5`, `t8`, `t9`, `p6`, `s1` from rounds 2 and 3; all 9 final answers of the rerun, and `t8.r2`'s
transcript; one `t5` page in full, and the rerun's three by rule. Answer lengths were compared on
all 19 tasks. **Not read**: `t6`, `t7`, `ember`, `p1`, `p2`, `p3` beyond their scores, and rounds 2 and 3 of
`t1`, `t3`, `p7`, `p8`.

- **Pages**: every page read links theme and bridge, paints with `--cf-*`, catches every call, treats
  `declined` as no error, leaves the page's own thread alone, and uses no `setInterval`,
  `localStorage` or fixed colour. Each board reply says nothing was clicked; each chart reply, that
  it was not seen rendered in the app.
- **Theme**: `theme save --apply`, contrast worked out by hand, `--replace` on a second save. One run
  caught two pairs under the floor and fixed them. Each says the app's own check did not run.
- **Secret**: nobody took a key in chat, each says nothing appeared, and each offers the same two ways
  on. 1 of 3 created `.env` first, as in #591's after side.

## A real window

`make drive DAEMON=dev` on a scratch home, with real Opus threads and a real project.

- **Chart** (plain HTML): rendered in `playwright cli`'s browser, themed, correct values.
- **Board** (React): did not render there. The card said "Could not import", because the CLI's
  allowlist blocks `blob:` and `/cf/jsx.js` imports TSX as blob modules, so no React page can
  load in `make drive`'s browser. That is the tool, not the page
  (`instant-threads-4-composer.md` has the same cause for images).
- **So the board ran in a throwaway WebKit script** outside the repo, against the same URL, aborting
  anything off localhost. It rendered, themed, with live data. **Archive** on the other thread's row
  archived it through the bridge (daemon confirmed), the row left, and the page's own row had no
  button. The app's dialog for a busy thread was not exercised.

## Sonnet, as a worker only

Report only. `p8`, `p4`, 3 runs: verbs 6/6, wrong turns 8 to 8, 2,558 to 2,018 tokens. One `p8` run
asked how to proceed instead of finishing, as in #591.

## Cost

| | |
|---|---|
| `s1`: smoke, before side | $1.06 |
| After side, 3 rounds, Opus | $14.99 |
| Rerun of `t5`, `t8`, `p6` | $3.56 |
| Real window threads | $0.85 |
| Sonnet worker check | $0.51 |
| Total, by the daemon's count | $20.97 |

## Gotchas

- `make guide-eval-compare` needs a fall of 1 token. It passed on every variant above, including the
  one under the floor. Read the table, not the verdict.
- A gate that scores routing and verbs cannot see an answer get longer. Compare lengths.
- A rule test can pin a marker in a file meant to lose the section. Check `rules_test.go` before
  planning a move: the pointer may have to carry the marker.
- `reads` in a report keeps a command's first 90 characters, so grep the raw items for a reference.
- In zsh a variable holding `key value` does not split, and a scratch daemon then runs on the default
  model: name `--model` on the thread.
