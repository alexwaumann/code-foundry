# Ember fixes 2: parent rollup, task start --task, branch on done (2026-10-21)

PR A of the second Ember battle test (`/tmp/ember-r2/results/SYNTHESIS.md`). It fixes
e2-1/e2-2, e3-7, e6-5/e6-6, e7-4/e7-5, e8-4/e8-6, e10-3, e10-6, e11-1, e12-7, e9-7 and
e4-8: the daemon side of the task board. The GUI wording, work rows, restart notice and
skill rewrite are other PRs (B, D, E).

## What changed

- **Parent rollup** (`ember.Rolled`, `Store.rollupLocked`). An open parent's state is
  derived from its subtasks every time one of them is written (added, updated, blocked
  by its worker's report, reset at load), and for every parent at load:
  - every open subtask blocked: blocked;
  - any subtask doing or blocked, or one done while others wait: doing;
  - none started (all open ones todo): todo;
  - all closed: left as it is (Ember closes the parent);
  - a done or cancelled parent stays as Ember set it, even when a new piece starts.

  A write to the parent itself keeps Ember's value until the next subtask write. The
  GUI's board header ("N in progress · M up next"), sections and the chat header's
  "queued" read the parent's own state, so they are right without GUI changes.
- **`ember task start --task <id>`** starts a worker for a todo or blocked task on the
  board. The task's title names the worker; `--task` takes no title, detail or parent
  (refused with a pointer to `ember task update`). A doing, done or cancelled task, or
  a parent with subtasks, is refused. On success the task becomes doing, linked to the
  worker, and its outcome is cleared (an orphan's "never started" note, a blocked
  task's reason).
- **The task is written only after `thread.new` succeeds.** A new task is checked first
  (`Store.CheckTask`: title, detail, parent), gets its id up front
  (`ember.NewTaskID`, injectable as `EmberDeps.NewTaskID`) for the worker's labels and
  request id, and `AddTask` (new `NewTask.ID`) writes it doing with the thread id in one
  row. A failed start writes nothing ("the worker did not start, so no task was
  added"); with `--task` the task stays as it was. The old "cancel the task when the
  worker did not start" path is gone.
- **Orphans at load** (`resetOrphansLocked`). A doing task with no worker and no
  subtask goes back to todo with the outcome "its worker never started (the app
  restarted at HH:MM)", logged at WARN. `Store.ResetAtStart()` returns them for PR B's
  restart notice; nothing reads it yet.
- **Branch on done.** `ember_tasks.branch` (migration 0043, `TEXT NOT NULL DEFAULT ''`),
  `Task.Branch`, `TaskUpdate.Branch` (trimmed, `origin/` dropped, one word, at most 250
  bytes). `ember task done --branch` records it once `origin/<branch>` was found in the
  worker's worktree; `--branch` on a parent is still refused (no worker). It is printed
  by `ember task show` (`branch: …`), `ember task list` and every task line
  (`· branch …`), BOARD.md and `ember board`, and the JSON view (`branch`). Proto
  `EmberTask.branch = 13`. The GUI card shows it under the outcome, in mono with a
  branch icon, with a tooltip when truncated (`ember-task-branch`).
- **Stale reports hidden** (`staleReport`). On a doing task, a worker's final report
  (done, failed or blocked) filed before the task last changed is dropped from the
  derived `TaskThread`, so the CLI, BOARD.md and the GUI show the worker's status
  without the earlier run's "report done". It is the rule that already keeps a failed
  report from re-blocking a task Ember set back to doing. Progress reports always show.
- **Done today on BOARD.md** takes a task cancelled today (`UpdatedAt` since midnight,
  as the GUI's `boardSections` does) and any closed subtask of a parent closed today;
  "Earlier" counts only the rest.
- **Skill** (`code-foundry-ember/SKILL.md` steps 2 and 3 only): add every piece as a
  subtask at once, dependent ones too, then start each with `ember task start --task
  <subtask id> …`; a one-piece request still uses `ember task start "<title>"`.
- **Mock**: tasks carry `branch`; the seeded done task t-3a4b5c6d has one;
  `/__mock/ember/task` takes `&branch=`.

## Decisions

- The rollup runs in the store on writes, not when the snapshot is built: the state is
  persisted, so `ember task list`, BOARD.md, the counts in `EmberStatus` and the GUI
  agree, and the CLI's `[doing]` is the stored value.
- "Started" for the rollup means doing, blocked or done. A cancelled piece with the
  rest todo leaves the parent todo.
- `--task` also takes a blocked task (e6-5's suggestion): restarting a blocked piece
  with a fresh worker is the common case, and the old link is replaced.
- Staleness compares with the task's `UpdatedAt`, not the thread's last user message:
  the snapshot is built without reading items, and the cases that matter (reopen,
  rename while steering) all touch the task.
- The orphan rule skips tasks with subtasks: a parent has no worker of its own.

## Live check (Haiku 5.5 medium, scratch home)

`CODE_FOUNDRY_HOME=/tmp/ember-fix-a`, `daemon --dev` from this worktree with
`CODE_FOUNDRY_BIN` set; ember.model, worker_models, threads.default_model and
naming_model all `claude-haiku-5-5[1m]`, efforts medium; a scratch `tally` Go repo with
a local bare origin under `~/ember-fix-a-scratch`.

1. **Orphan.** `ember task add "Orphan probe" --state doing`, daemon stopped (SIGTERM)
   and started: the task was `[todo]` with "its worker never started (the app
   restarted at 02:37)", and the log had `ember: a doing task had no worker; back to
   todo`.
2. **Two pieces.** "In the tally project, two pieces: a -w flag with a test, and a
   CONTRIBUTING.md … each on its own branch, pushed; no PRs." Ember (37.9 s, $0.009)
   loaded both skills, ran `ember task add` for the parent, then two `ember task add
   --parent` (todo), then `ember task start --task t-c1f8db2f …` and `--task
   t-b0917342 …`. The log shows `parent task follows its subtasks … from=todo
   to=doing` at the first start; `ember task list` showed the parent `doing` with both
   pieces working.
3. **Done with branch.** On the two wakes Ember checked `origin/<branch>` in each
   worktree and ran `ember task done <id> "…" --branch feat/tally-word-flag` (and
   `docs/contributing-test-guide`), then closed the parent. `ember task show` printed
   `branch: feat/tally-word-flag`; `ember board` put the parent and both pieces under
   Done today with `· branch …` on each piece. Turn: 11.4 s.
4. **Stale report.** `ember task update t-c1f8db2f --state doing`: the line read
   "worker … needs attention (finished), now · branch …" with no "report done"; `ember
   task done` brought the report back.
5. **Refusals.** `ember task start "…" --project nope` failed and added no task;
   `ember task start --task <a done task>` was refused ("only a todo or blocked task
   starts a worker").

Three threads, about $0.02 in all, no ERROR lines in the daemon log, one WARN (the
orphan). Then the daemon was stopped and the scratch home, repo and their
`~/.claude/projects` folders deleted.

## Gotchas

- A cancelled task now shows under Done today on BOARD.md (the probe did), as on the
  GUI's board. Before, every cancelled task was "Earlier".
- When `thread.new` fails on an argument (an unknown project), the CLI prints thread.new's
  own argument error ("thread not found: project nope") rather than the "no task was
  added" wrapper: the ArgError wins in the CLI's rendering. Nothing is written either way.
- A crash between `thread.new` returning and `AddTask` leaves a worker with no task (it
  still carries the ember and task-id labels). The window is one SQLite write; the old
  order left the reverse, a doing task with no worker, for the whole spawn.
- `make check` under heavy machine load (load average 55 with other agents' daemons)
  timed out the daemon-start e2e tests under `-race` (5 s readiness waits during
  migrations); they pass on a rerun at normal load.
- Migration 0043 is the next number on main as of this PR; a parallel PR adding a
  migration must renumber.

## Daemon restart

Needed after merging: migration 0043, the store and command changes, the proto field.
