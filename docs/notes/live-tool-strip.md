# Live tool strip: a running turn's runs of work as one row each

While a turn ran, every tool call was its own row, so a long turn was a wall of rows
between Claude's texts. Alex's decision (2026-10-18): while the turn is live, each run of
work collapses to one row. Once the turn ends nothing changes from before: the turn folds,
and unfolding shows the flat rows (and explore groups) as they always were. Frontend only;
no new persisted state, no new item kinds in the daemon.

## Behaviour

* **A run** (`lib/threadTimeline.ts stripRuns`) is a maximal sequence of consecutive tool
  rows, explore groups, Agent rows and thinking rows in the open turn's body. Anything
  else breaks it: assistant text, a steer (wake rows are steers), notes (error,
  compaction, command output), a question (AskUserQuestion: its call is hidden, the
  question row stands for it), a permission row (`PermissionRow`, denied before the tool
  ran), and a tool row with a permission request attached.
* **Steps** count tools and groups: a group is one, an Agent is one, thinking is none (it
  is absorbed into the run and shown when expanded, never as the latest step). A run of
  two steps or more is a strip; a run of one step stays as its rows (thinking included),
  so `[thinking, Bash]` is not a "1 step" strip. Note the strip's count is not the live
  header's: the header's `stepCount` also counts non-final text and thinking.
* **Collapsed** (`rows.tsx StripRow` / `StripLatest`): a normal 24px `Row` with the latest
  step's icon and label (`ToolLabel` for a tool or Agent, `groupLabel` for a group).
  Running: the icon slot holds the sky spinner (`t-sky animate-spin`), the label is in the
  running tense, and the meta is the elapsed time on the shared 1 s clock and the step
  count ("12s · 3 steps"). Finished latest step: just "12 steps" (its own "ok · 1.3s" is
  left out). Chevron right; a click expands, it never opens the tool detail.
* **Expanded**: an "N steps" head (lucide `List`, chevron down) over the run's own rows
  (`WorkNodeView` each) in `.members`, the group's indent. A click on the head collapses.
* **Only the open turn** gets strips, and only through the new `strips` option of
  `buildRows` (absent: off). The subagent view (SubagentPane) never calls `buildRows`
  with it, nor do the existing component tests, so their rows are untouched.

## Decisions

* **When strips show: `strips`, not `working`.** `working` (the live header) goes false
  the moment a permission or question waits, but the break-out rule only matters while a
  request waits. `useThreadActivity` adds `timelineStrips = timelineWorking || busy`
  (`busy` includes waiting on the user; `timelineWorking` lingers 2 s past a stop, so the
  strips go away with the turn_end, not before it). ThreadPane and InlineThread pass it to
  `Timeline`. A crashed turn (no turn_end, process gone) is neither, so it shows flat.
* **Any attached permission breaks out**, allowed ones included (the `permissions` map in
  `workNodes`). If an allowed tool rejoined the run, rows would reshuffle the moment the
  user clicks Allow; this way the row the user just answered stays where it was.
* **Failed tools stay inside** a strip (Alex, explicitly).
* **Two keys.** The expanded state is `strip:<the run's first item id>` in the store's
  `expanded` map (`setRowExpanded`/`useRowExpanded` via `useToggle`): a group's first
  member, merged thinking's first item, so it holds as the run grows and when a lone Read
  turns into a group. Leaving the thread forgets it (`forgetTurnView`), like folds.
  The **row key** (React and the virtualizer) is the run's first node's own key. When the
  turn ends the strip is replaced by the flat rows, and that node's row has the same key,
  so the list's anchor maps the strip onto it: a reader scrolled into an expanded strip
  keeps their place, moving up by the head's height only. With a `strip:` row key the
  anchor fell back to the row before the run and the view jumped. A run growing from one
  step to two keeps its row too.
* `Timeline.tsx estimate` has `strip: 26`. No CSS was needed: the strip reuses `.row`
  and `.members`; the wrapper's `.strip` class has no rules.

## Tests

* `threadTimeline.test.ts` (table): text, steer, note, permission (attached and alone)
  and question breaks; a failed tool inside; single-step runs not stripped (thinking with
  one step stays rows); group and Agent one step each, thinking none; latest never
  thinking; expanded key stable as the run grows (tool first, lone Read becoming a group,
  thinking first); row key equal to the first node's and present in the finished rows;
  strips on while a request waits (`working` false); finished turns identical with and
  without `strips`, and the flat live turn unchanged without it.
* `rows.test.tsx`: running latest (spinner, "Running go test ./...", "12s · 3 steps"),
  finished latest ("Ran echo 11", "12 steps"), expand to the head and members and
  collapse, expanded state surviving a new call (rerender in place), a waiting tool after
  the strip as its own "waiting for you" row.
* e2e (`thread.spec.ts`): the mock's streaming thread already has a live turn with Write,
  Bash (failed), Edit, Bash and Agent between the question and the answer, so no mock
  change: one strip "5 steps", expand (5 rows, the Edit among them), collapse, then
  `thread/finish`: no strip, folded, unfolded shows the flat Edit row; both schemes.
  Two older specs opened that Edit row in the live turn ("reading deep into an open tool
  row…", "leaving a thread forgets…"); each now expands the strip first. The first also
  checks the anchor: after the end the Edit row sits where it was minus the head's height.
  Full `make gui-e2e` before the e2e changes: 996 passed, 4 failed (those two specs, both
  browsers); after: the four streaming spec files (122 tests) pass.

## Verified live

`make build && make gui-build`, this worktree's GUI with `CODE_FOUNDRY_HOME=/tmp/cf-strip`
and a no-project thread (`claude-haiku-5-5[1m]`, medium, auto). Gotcha: Claude Code's
harness now blocks a standalone `sleep 45` ("use Monitor…"), so Haiku ran it in the
background and the first turn ended at once. A second turn used
`python3 -c "import time; time.sleep(60)"` in the foreground: four `sleep 2` calls, ROUND
TWO, three `ls /tmp`, the python sleep, DONE. Mid-run the turn read: live header
"Working · 9 steps", "Ran sleep 2 · 4 steps", the ROUND TWO text, "Running python3 -c … ·
22s · 4 steps" with the sky spinner (`live-tool-strip/collapsed-dark.png`,
`collapsed-light.png`; light via the isolated home's `appearance.theme`, set back to
`dark`, Alex's value, before quitting, so the shared `cf.theme` localStorage entry
matches his app). A click expanded the second strip to "4 steps" over the three `ls` rows
and the running python row (`expanded-dark.png`). At the turn_end (pinned) it folded to
"Worked for 1m 17s · 9 steps · $0.01 · Haiku 5.5" and DONE; a header click unfolded the
flat rows as before ("Ran sleep 2 · ok · 2.5s" each, `finished-unfolded-dark.png`). The
app and its daemon were quit and `/tmp/cf-strip` removed.

Not exercised live: a permission or question breaking a strip (auto mode asks nothing;
unit tests only), and an Agent as the latest step (the e2e strip's latest step is the
mock's Agent, but its label is not asserted).

## Unrelated flake fixed on the way

`make check` failed twice on `surfaces/mcp.test.tsx` ("Checked 13s ago" for "12s"): its
`STATUS.checkedAtMs` was `Date.now() - 12_000` at module load, so under load the test
rendered more than half a second later. `beforeEach` now stamps it per test, and the
reconnect test reuses that stamp (a second `Date.now()` there read "11s", the panel's
shared clock having captured its `now` at mount).
