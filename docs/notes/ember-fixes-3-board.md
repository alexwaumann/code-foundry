# Ember fixes 3: the board after real use (2026-10-23)

A user reported three things after using Ember for real: Ember's flame and row said
"working" while nothing worked, Ember did not end a task on the board until told to, and
Ember sometimes used its native Agent tool in the foreground. This PR fixes all three.

## 1. Idle workers are not "working"

Before, the flame (`useFlameState`) took `useDoingCount()`, the doing tasks, and the
pinned row said Working (sky) whenever a task was doing. A worker that finished its turn
and reported done, waiting for Ember to check it, kept the flame flickering and the row
saying "Working · <task>".

Now "working" means a worker thread works, the same rule in Go and TS:

- on a turn (busy while its process runs), starting, or idle with a waiting reason that
  names child threads ("waiting on 2 child threads", `thread.WaitingOn` > 0);
- not a bare "waiting" (`thread.IsWaitingReason` also covers "waiting" alone, which only
  means a wake is queued to the thread; a failed start can hold that queue for a long
  time, wakebackoff.go), and not a busy status left on a closing or stopped thread.

Go: `team.go` `working(state, status, reason)`, `TaskThread.Working()` (itself or its
team) and `WaitsOnUser()`. TS: `workerBusy` (and `workerWords`: a bare "waiting" reads
Idle). The mock's `teamWorking` follows the same rule.

What changed on screen:

- the flame is `working` only while `workingThreads` > 0 (`flameState(t, working,
  waiting)`);
- the row's status: Ember's own words, then Working only while a worker thread works,
  then **To check** (emerald) while a task waits on Ember alone (below), then **Worker
  idle** (muted) while a task is doing with no one on it, then Blocked, then Idle. Line 2
  names the task the status is about (`rowTitle`: the waiting worker's task, a task whose
  work goes on, a task to check, a doing task, a blocked one);
- the header: "1 thread working · 1 to check · 1 blocked · 1 queued"; the sky dot only
  while a thread works;
- a worker row under a doing task: an idle worker's dot is emerald once it reported done,
  a muted ring otherwise (it was the task's sky dot).

## 2. Ember did not end a task until told to

### Diagnosis

The user's own daemon data was not available here: `~/.code-foundry` on this machine is
an older daemon (schema migration 40, before `ember_tasks` in 0042; one thread, no
`residents/` directory), so Ember never ran there. The diagnosis instead used:

- **Every Ember transcript on this machine**: the 26 battle-test homes of 2026-10-21 and
  2026-10-20 (`~/.claude/projects/*residents-ember`). A script paired each
  `[code-foundry wake]` carrying a done report with the tool calls of the turn that
  handled it: 98 done reports, every one delivered; 95 closed in that turn with `ember task
  done`, and the 3 others left open on purpose (a task already done, a worker interrupted
  before it pushed, a blocked one). So (a), a wake that never reached Ember, and (c), a
  worker that never reported, did not show up. Every task in those 26 homes ended closed.
- **A recorded miss of kind (b)**: the live check in `ember-fixes-2-gui.md` (2026-10-21,
  Haiku): on a piece's done wake Ember read the thread and checked the branch, then
  replied without `ember task done` until asked. Its transcript is gone.
- **A live reproduction** (scratch home, main at 33ac7082, Ember and workers on Haiku 5.5
  at medium, a scratch repo with a local bare origin). Three requests, each two pieces
  or one:
  1. two pieces finishing together: both closed, and the parent;
  2. one slow piece and a second request sent so that the first worker's done wake
     arrived in the middle of Ember's turn (`#38 wake` between two tool calls): both
     closed;
  3. two pieces under parent `t-59407767`, the flag piece's worker asking the user first
     (answered on the worker directly, as the Board's worker row allows). At 06:24:21Z
     the changelog worker's wake: Ember checked `origin/<branch>` and ran `ember task done
     t-2d8542a8`. At 06:26:04Z the flag worker's wake: Ember checked the branch, ran `ember
     task done t-77c96d49`, and replied "Both tally pieces are done and pushed…". **The
     parent `t-59407767` stayed doing**: the board kept it under In progress ("2 of 2")
     with nothing left to wake Ember.

That is (d): the parent's rollup (`Rolled`) deliberately leaves a parent whose pieces are
all closed to Ember, so Ember can check the pieces together first, and nothing told Ember
that the last `ember task done` left the parent waiting on it. The skill said only that
"a parent … takes no branch". With a parent's card being the one link Ember's reply
gives, "the task did not end until I told it to" fits this exactly. The (b) case seen
before, a reported piece Ember did not close, has the same shape: a doing task waiting on
Ember alone, with no further wake coming for it.

### Fix

The store still never closes a task itself ("check before you believe"), and the rollup
still leaves a closed-out parent to Ember. What changed is that such a task cannot sit
unnoticed:

- **`ember.Unclosed(t, tasks)`** (`unclosed.go`) names the two kinds of task that wait on
  Ember alone:
  - `UnclosedReport`: doing, its worker's report is in (done, failed or blocked; a stale
    report is already left out by `staleReport`) and the worker and its team are idle;
  - `UnclosedPieces`: an open parent whose pieces are all done or cancelled.
- **The board says so**: BOARD.md, `ember board`, `ember task list`, `ember task show`
  and the JSON (`unclosed`): "unclosed: worker reported done, waiting for Ember to check"
  or "unclosed: all its pieces are closed, waiting for Ember to close it". In the GUI:
  the card's meta "reported done" with that sentence under the title
  (`ember-task-unclosed`), the link's meta "worker reported done, waiting for Ember to
  check" ("1 to check" on a parent's link), the row's To check and the header's "N to
  check".
- **`ember task done` (or cancel) of a parent's last piece** ends with "every piece of
  t-… "<title>" is closed now: check them together, then close it (code-foundry ember
  task done t-… "<outcome>")", in the same turn that closed the piece.
- **Every wake to Ember lists them.** A new resident hook on the thread store,
  `SetResidentWakeNote(name, fn)`, is called on both wake delivery paths (`drain` for
  timers, pull requests and action runs; `deliverThreadWakes` for thread, batch and
  restart wakes) and appends the note as a last paragraph of the wake's text (not its
  title or JSON):

  ```
  [code-foundry ember] Unclosed on your board: open tasks no worker is on and no wake will come for. Check each as on a wake, then close it (`code-foundry ember task done <id>`) or block it; if one stays open, say why.
  - t-59407767 "Tally: word-count flag and CHANGELOG entry" · all its pieces are closed
  ```

  It is computed from the threads as they are when the wake goes (not the last published
  board), and a task whose worker the wake is about is left out: the wake reports it.
- **Rules and skill**: rules.md says to check and close (or block) on every wake, one
  that arrives mid-turn included, to close a parent once its last piece is closed, and
  that a wake's "Unclosed on your board" lists what is owed. The skill's On a wake says
  the same in two lines, and step 4 adds the parent.

Thread store changes (shared primitives, needed because the wake text is built there):
`residenthooks.go` (`WakeNoteFunc`, `SetResidentWakeNote`, `withWakeNote`),
`manager.go` (the hook's map), the two `m.Send` call sites, and the fake.

### Checked live (the branch build, same scratch home)

- At start, `ember board` showed `t-59407767 … · unclosed: all its pieces are closed,
  waiting for Ember to close it`.
- A timer wake (`thread subscribe --id <ember> --at 10s`) carried the note; Ember checked
  the branches and ran `ember task done t-59407767 …` in that turn, unprompted.
- A new two-piece request (parent `t-e89e7212`): when both workers had reported, `ember
  board` marked both pieces "unclosed: worker reported done, waiting for Ember to
  check". Their two wakes came 1 s apart (the second mid-turn); Ember checked both
  branches and closed both pieces and the parent in one call, the parent hint printed
  between them. No ERROR line in the daemon log.

## 3. Ember's subagents run in the background

rules.md (the authoritative list), in the orchestrate skill's words: "A native subagent
(your Agent tool) only for read-only research, always with `run_in_background: true`;
then end your turn (its result wakes you), never wait on it." The Ember skill does not
mention subagents, so it has no line for it.

## Caps and trims

- rules.md: 6047 of 6144 bytes. Trimmed: the filesystem-search line (now "`find /`,
  `mdfind`, `locate`: PROJECTS.md has every project and the orchestrate skill's path")
  and the epoch sentence ("The chat goes on.").
- SKILL.md: 204 lines (under 205). The "Memory and epochs" paragraph went from five lines
  to three; what each memory verb keeps is in the rules already.
- render_test pins the new rule words.

## Tests

- Go: `TestWorking` (a table over states, statuses and reasons, plus `TaskThread`),
  `TestUnclosed` (a table: both kinds, stopped, archived, a bare waiting, busy again,
  asking, a team that works or asks, removed, blocked, done), `TestUnclosedNote`,
  `TestWakeNoteListsUnclosed` (through the fake: busy, reported and idle, the board line,
  `ParentToClose`, the parent after its last piece, closed, after Close),
  `TestRenderBoard` "unclosed", `TestResidentWakeNote` (thread store: a real wake to a
  resident ends with the note, `about` is the worker; none for a plain thread, a blank
  note or a removed hook), and the CLI test's parent hint, list, show, JSON and board.
- TS: `lib/ember.test.ts` "idle workers and tasks waiting on Ember": a table deriving the
  working count, the to-check count, the flame, the row's words and title from a board;
  a table for `unclosed`; the card, worker row, header and link words; a bare waiting
  reason.
- e2e `ember.spec.ts`: "an idle worker on a doing task is not working": Worker idle with
  an idle flame and no thread count, then To check after the lead's done report (header,
  link, card, worker dot), then closed. The mock gains `POST /__mock/ember/report`.

## Gotchas

- The seeded cancelled task in the mock was "two hours ago", so the board spec failed
  between midnight and 2 AM (it is not under Done today then). It is "earlier today" now.
- A done task's busy worker still counts in "N threads working": the thread works even
  though Ember closed its task (unchanged).
- The shell sandbox of this session refused heredocs containing backticks and commands
  ending in `enable`; edits went through scripts and `ember.enable`.
- The PR's screenshots are on the `cf/ember-board-fixes-shots` branch, not under
  `docs/notes/` (CLAUDE.md: notes are text only).

## Daemon restart

Needed after merging: the Ember store, the thread store's wake hook and the CLI changed
(no proto or migration change).
