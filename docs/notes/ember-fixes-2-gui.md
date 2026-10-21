# Ember fixes 2: the GUI (2026-10-21)

PR E of the second Ember battle test (`/tmp/ember-r2/results/SYNTHESIS.md`, findings e4-1/3/7,
e5-1/2/5, e6-7, e1-1/6, e11-4/5/7, e9-5/6, e13-6, e10-4, e3-6, e2-10). Frontend only: no
proto or daemon change. It reads what the daemon already writes (status reasons, the
`process_ended` turn end, wake JSON, `EmberTask.branch` from #294, the board's timers from
#293).

## Header and pinned row

- `headerSummary(tasks, timers)` returns `{text, dot}`: "1 needs you · 2 threads working · 1
  blocked · 1 queued · 1 scheduled". Workers waiting on the user (`waitingThreads`), working
  threads, blocked tasks (`blockedTasks`), todo tasks, pending timers. With none of those a
  doing task still reads "N in progress" (a worker finished, Ember has not closed the task),
  so the header never says less than the Board; "Nothing in progress" only for "". The dot
  is amber while something waits on the user or is blocked, sky while workers run.
- `blockedTasks` counts blocked tasks with no blocked subtask (PR A's rolled-up parent counts
  as its pieces) and leaves out one whose worker or team asks (that one is "needs you").
- "needs you" covers a question, a permission and a budget stop alike: all three need the
  user, and "needs your answer" reads wrong for a budget stop.
- Timers: `pendingTimers(board)` is the board's `timers` (#293) count; the row says "· N
  scheduled" too. In e2e through #293's `/__mock/ember/timer`.
- Pinned row words (`emberStatusWords(t, {doing, waiting, waitingWords, blocked})`): Ember's
  own prompt or error; a turn the app's restart cut ("error" + "interrupted") reads
  **Interrupted** in amber, not a red Error; then the first waiting worker's words (Needs
  input, or "Stopped at budget"); Ember's own Finished/Working; Working while a task is
  doing; **Blocked** (amber) while a task is blocked; Idle. Blocked sits after a doing task's
  Working on purpose: the row's line 2 names the doing task then, and "Blocked · <a doing
  task>" would misname it. The row shows "· 1 blocked" after the thread count instead.
- Line 2 (`rowTitle`): the waiting worker's task (`waitingTitle`: a task whose own worker
  asks before a lead whose team member asks; "+N" when more wait), else the first doing
  task, else the first blocked piece.

## Budget stop

`budgetStop(th)` matches status attention with reason "budget reached"; the amount is the
first `$x` or `$x of $y` after it. The daemon's reason has no amount today
(`internal/store/thread/budget.go`), so the words are "Stopped at budget"; a daemon that
appends one ("budget reached: $0.21 of $0.20") gets "Stopped at budget · $0.21 of $0.20".
`workerWords` checks it before the status switch, so the card, the worker row, the waiting
words and the pinned row all say it. A budget stop still counts as waiting on the user (the
bell's rule from G2).

## Task links

- The title is the board's (`useLinkTitle`), the link's text only while the board does not
  have the task, so a rename reaches every link.
- The down chevron became lucide `SquareKanban` (the row menu's Open board icon) and the
  whole pointer has a shadcn Tip "Open on the board".
- `linkMeta` returns `{parts, waiting}`: "needs you" (amber) replaces the state word while a
  worker of the task or its pieces waits on the user (e5-5 a). A done task with a branch
  shows it after the meta (`useLinkBranch`).
- e5-5 b (answer buttons under a relayed question) is not built: the synthesis lists it as a
  design question.

## Work rows

- `shellSegments` splits a Bash command into simple commands on newlines, `;`, `&&`, `||`
  outside quotes (a pipeline stays one), drops heredoc bodies (the skill's `--prompt -
  <<'EOF'`) and comment lines; a `\`-newline joins lines. Each segment is classified on its
  own (`countCommand`), after dropping shell keywords (`do`, `then`, `{`), `NAME=value`
  environment words and quiet commands (`cd`, `echo`, `for`, `done`, `[`, …).
- New words: `ember task start` "started N workers"; `thread send` "sent a change to <name>"
  (the thread list's name, "a worker" when unknown; "sent changes to N workers" for several);
  `ember task done` "closed N tasks"; `thread respond` "answered N questions"; `thread
  archive` "archived N threads"; `project worktree cleanup` "cleaned up worktrees";
  `cat`/`sed -n`/`head` count as files read and `grep`/`rg`/`ls`/`find` as searches.
- Branches: a reading git command (`log`, `diff`, `show`, `merge-tree`, …) names branches by
  its range's right side or a ref-looking argument, `origin/` dropped, `main`/`HEAD` left
  out, `$VAR` expanded from earlier `VAR=` segments of the same call. They count by name; a
  `git -C <dir>` checkout that named none counts as one. "checked 2 branches". Plain git
  without either stays "checked git".
- What woke Ember leads the line (`wakeLabel` over the wake's JSON): "wake from <thread>",
  "timer" (with #293's note: "timer: <note>"), "restart", a batch from one thread as that
  thread, from several "N wakes"; a wake whose JSON says nothing falls back to its title's
  `Thread "<name>"`, else "1 wake".
- Every finished run shows its end time on the right (`runEndMs`, `clockTime`: "14:02", a date
  before it on another day), like a user bubble's time.
- A wake run that only thought now keeps its row when Ember's text follows it (`flush(…,
  reply)`); G6's rule (no row) stays for a wake Ember only acknowledged with nothing said.
- Not done: a reply with no run before it (a model that writes text straight after the
  user's message, without thinking) has no time of its own; the user's bubble just above
  carries one.

## Restart line

`restartCuts(log, cutNow)` finds the turn ends the app's restart cut. A candidate is a
`process_ended` + interrupted turn end (`turnclose.go`) with no error item in its turn (a
crash has "Claude stopped unexpectedly"). It is a restart when:

1. a tool in that turn ended "Interrupted: the daemon stopped." (`stream.go` shutdown), or
2. the next top-level user message is a restart wake (`kind: restart`, or a batch with one:
   `subscriptions_restart.go`; its `restarted_at` gives the time), or carries the resume
   note "…because the Code Foundry app restarted…" (`resumenote.go`), or
3. it is the log's last turn end and Ember's status is still error "interrupted" (the status
   reason, for a cut with no tool running and no message since).

`buildEmberRows` ends the run at that turn end and adds a `restart` row: "Code Foundry
restarted at 01:26 while Ember was working" (RotateCcw, muted, `role="note"`). The time is the
restart wake's when one follows, else the turn end's (the stop). The hook passes the cuts to
the memo as "<id> <ms>" strings through a shallow selector.

## Board

- Worker age: "updated 4m ago" / "updated just now" (`updatedAgo`); the row's run time
  (synthesis "and the run time when known") is not added: the board has no start time for a
  team member and a worker's createdAt is not its run.
- A done or cancelled subtask's row shows its outcome (muted, tooltip when cut) and a done
  one's branch on a line under it (`BranchLine`, shared with the card's branch). This applies
  on any card, so a running parent's finished pieces read too.
- The task's own worker row says "Worker" (or "Lead" with a team) when the thread's name is
  the task's title (case and punctuation aside), so a card no longer repeats its title.
- A lead's report summary has its team's ids replaced by their names (`withNames`, names
  from the card's threads and listed team); an unknown id stays.
- e3-6's frozen team summary on done cards needs the daemon (the team is derived for open
  tasks only) and is not here; done pieces show their own outcome and branch instead.

## Mock

- `mock/emberChat.ts` now has seven runs and seven task links: the flaky-test worker started
  with `ember task start` and linked by an older title; its wake, a `git -C $W` branch check
  and `ember task done --branch`; two workers started in one call with heredoc prompts; the
  wails wake; a follow-up sent with `thread send`; the lead's progress wake replied to
  without a tool; a timer with a note replied to without a tool.
- `POST /__mock/ember/restart?step=cut` appends a turn the restart cuts (a tool "Interrupted:
  the daemon stopped.", a `process_ended` turn end) and stops Ember's thread busy (error
  "interrupted"); `step=wake` appends the restart wake and a reply, finished.
- The board seeds a done piece under the release notes (outcome and branch), and the lead's
  report names its workers by id. `POST /__mock/ember/task` takes `title=`.

## Tests

- `lib/ember.test.ts`: header text and dot (blocked, waiting, timers, the in-progress
  fallback), row words and title (+N, Blocked, Interrupted, budget words), budget amounts,
  link meta with "needs you", done-subtask rows, Worker title, names for ids, the age label,
  `restartCuts` (tool, resume note, restart wake, status, crash), restart rows, the quiet
  wake reply's row, `shellSegments`, `wakeLabel`, and `workSummary` over seven commands
  captured in the battle test.
- `e2e/ember.spec.ts`: updated counts and summaries (seven rows, each with a time), plus
  header/row counts and the waiting worker's task, a budget stop, link title/glyph/tooltip/
  branch and a live rename, the restart cut and wake, and the board's ages, done piece,
  Worker title and lead names. The chat is pinned to its bottom, so a spec that clicks an
  early row wheels up first (`wheelTo`, as `path-chips.spec.ts` does).

## Verification

- `make check` green; `e2e/ember.spec.ts` 17 passed after the rebase (before it, 48 of 48
  with `--repeat-each 3`).
- Live (2026-10-21): `make build`, `CODE_FOUNDRY_HOME=/tmp/ember-fix-e bin/code-foundry daemon
  --dev` (with `CODE_FOUNDRY_BIN`); every model `claude-haiku-5-5[1m]`, efforts medium; a
  scratch Go repo `tally` with a local bare origin under `~/ember-fix-e-scratch`; `ember.enabled`
  on. The frontend ran from Vite on :9451 with `?daemon=…&token=…`, shot with Playwright
  WebKit at 1440×900 @2x, dark and light.
  1. "Two pieces … for the flag piece, tell its worker to ask me … -w or --words." Ember added
     a parent and two pieces and started both workers; the flag worker asked. The chat header
     read "1 needs you · 1 thread working" (amber dot), the row "Needs input · tally: -w flag
     counts wo…" (the asking worker's task, not the other piece), the links "needs you" in
     amber, the wake run "Worked for 30s · wake from tally: -w flag counts words", every run
     with its time. The first run read "read 3 files, started 2 workers, updated the board,
     checked git, …".
  2. After `thread respond --answer=-w` both workers pushed. The wake runs read "wake from
     tally: short CONTRIBUTING.md, closed 1 task, checked 1 branch" and "wake from tally: -w
     flag counts words, read 1 thread, checked 1 branch". Haiku forgot `ember task done` for
     the -w piece (a skill-adherence slip, not the GUI's); asked to close it: "closed 2
     tasks". The board's done card listed both pieces with "done", "updated 10m ago", the
     branch and the outcome under each; links read "· done · ⎇ <branch>"; the header said
     "Nothing in progress" only then.
  3. A third piece, and SIGTERM to the daemon while Ember's `ember task start` ran, then a new
     daemon. The chat drew "Worked for 6s · started 1 worker", "Code Foundry restarted at
     10:51 AM while Ember was working", then the restart wake's run "restart, read 1 thread,
     checked the board" and Ember's reply. Main's daemon already sends the restart notice for
     a cut turn, so the row went back to Working by itself; the -c worker's row on the board
     read "Worker" (its name is the task's title).
  4. The first shots showed done pieces squeezed to "t…" in the side panel: the outcome took
     the meta slot. A done piece's outcome moved to the line under it, beside the branch.

  Then both daemons and Vite were stopped and `/tmp/ember-fix-e`, `~/ember-fix-e-scratch` and
  their `~/.claude/projects` entries were deleted. Shots: the PR body (branch
  `cf/ember-gui-2-shots`).

## Gotchas

- A link inline in Ember's prose ("I started the -c piece: [title](cf-task://…).") still
  renders as its text only (react-markdown drops the scheme; ember-3-gui.md). Only links
  alone on their line become pointers.
- A Bash call the restart cut still counts in its run ("started 1 worker"): the summary reads
  the command, not its outcome.
- Rebased onto main after #293 (timers) and #296 (crashed status, restart notice for cut
  turns) merged: only import lines and the mock's control regex conflicted. A crashed Ember
  still reads Error (red) on the row; only "interrupted" (the app's restart) reads
  Interrupted (amber). The live run above was on the pre-rebase build; main's daemon already
  sent the restart wake there.
