# Instant threads 2: the ways out of a setup

PR 2 of 4. PR 1 gave Create a setup stage that can run in the background; nothing sends
that flag yet, and this PR does not either. It adds what the GUI's buttons will call, so a
failed or cancelled setup always has a way out: Try again, Cancel, Discard (the GUI's Edit),
Remove, and messages sent during a setup. The blocking path stays as it was, but for
rollback's rules below, which are better for it too.

## What changed

- Three commands, `thread.setup.retry`, `thread.setup.cancel`, `thread.setup.discard`
  (`commands_thread_setup.go`), over `ThreadService.RetrySetup`, `CancelSetup`, `DiscardSetup`
  and `Store`'s methods of those names (`setup_actions.go`).
- `Send` during a background setup queues on the row, and after a failure or a cancel it
  tries the setup again too (`sendToSetup`).
- Remove, Discard and Cancel clean up through `cleanSetup`; `rollback` gained the rules
  (below), so a Move's and a start's rollback follow them too.
- A failed blocking setup is cleaned from the row like any other. A blocking setup the
  daemon lost is discarded at the next start.
- `project.Store.AbandonWorktree`, `RemoveWorktreeOptions.DeleteMadeBranch`, and `WorktreeEvent`
  says where an add goes, on what, and from which commit.
- `ExecRunner` kills a cancelled git's whole process group.
- No migration: everything new is in the `threads.setup` JSON.

## Decisions

- **Force: no, decided by `TestCleanupOfARealWorktree`.** Once a placement landed anyone can
  work in the worktree, and a start that failed leaves it there. So a cleanup never forces:
  git keeps a worktree with changes or untracked files, and Cancel and Discard list it in
  `kept_worktrees`. Its branch stays with it. A worktree held by another thread is not
  listed: it is that thread's now, not something left behind.
- **A branch goes only if nobody moved it** (`DeleteMadeBranch`: tip still at
  `Worktree.CreatedHead`). The old `Force` deleted whatever the worktree had checked out, and
  without force the merged-into-default rule would have kept a new branch from an unmerged
  base, so Cancel would have left it. A branch with a commit stays, and that is no error.
- **`OwnBranch` next to `NewBranch`.** A local branch git's DWIM made from origin's is this
  setup's to remove, while `NewBranch` still says "new here and on origin" for summaries. Rows
  from PR 1 count `NewBranch` as both.
- **Holders.** `heldElsewhere` is `otherHolder` plus `Setup.Held`: a thread in setup has no
  checkouts yet, so it notes a worktree it is about to share, in `makeWorktree` under the
  lock a cleanup takes. Either it notes it first and the cleanup keeps it, or the cleanup goes
  first and it makes its own. Archived threads hold no worktree, as for any cleanup, but do
  hold a branch (`branchHeld`).
- **What a killed add leaves is undone in two places.** Live, by `CreateWorktree`, the one who
  knows the path was free. After a daemon death, from `Setup.Adding`, written before git
  starts and dropped when the add ends. `undoAdd` looks first: git locks a worktree until its
  checkout is done, so an unlocked one is whole, and goes without force or not at all. Only
  a locked or unlisted one gets `--force --force` and `RemoveAll`. Paths outside the
  worktree root are refused.
- **The retry's reopened turn: the old turn end is deleted.** Moving the message after it
  leaves an empty turn, and changing its kind leaves a second failure display for PR 3 to hide.
  So `dropItem` removes it, `ItemsReset` tells watchers, and `WatchThread` sends a new
  snapshot, which clients take already (a resync after drops). Go only: no proto or GUI
  change. `HandledThrough` is worked out again from the items. A wait in a retry finds no
  turn end: it settles on the real one, or on the next failure's.
- **Who decides a race.** `spawn`'s commit and `settleSetup` read `setupJob.cancelAsked` under
  `m.mu`. A cancel first means the spawn abandons its process, or the stage settles as
  cancelled; the commit first means Cancel answers "too late"; a failure first means Cancel
  says it failed. Never half of each.
- **Cancel and sends are refused on a blocking setup.** Its caller owns it, and its failure
  takes the thread: a message accepted there could vanish. `ThreadSetup.background` says which
  it is, so the GUI can tell.
- **A wake is refused during and after a setup**, as in PR 1 (logged, not delivered). It must
  not try a setup again by itself, and a queued wake would have needed the wake fields on the
  row and a filter in Discard.
- **`Setup.Queued` rather than a column.** It lives as long as `PendingFirst`, past the
  setup's success, until Claude has it. `done` keeps it. So no migration, and a thread with no
  first prompt works the same.
- **Queued prompts are stored as built, and `spawn` rewrites them.** They can be sent before the
  worktrees exist, and a rewrite at Send would race the landing. Messages that come while
  `spawn` runs are picked up at its commit (`lateMessages`), before `run` starts.
- **A placement that landed stands.** A retry goes straight to the start when the row has a cwd
  and its checkouts exist: no re-plan, so a `Like` that went since does not matter. Otherwise it
  plans again, inside the stage, so a refusal is a setup failure with a step showing it.
- **A retry refreshes its projects first.** Seen end to end: fix what stopped it, Try again at
  once, and the snapshot still said the main checkout was on the branch.
- **Retry always runs in the background**, and a blocking setup's row never stays failed.
- **A retry brings an archived or snoozed thread back**, as a message does.
- **After a cancel, running and failed steps go back to pending**, and a fetch the setup killed
  is no "Could not reach origin" warning. The steps that ended stay as they ended until a
  retry, which puts them all back.
- **Palette: not listed, no chord.** `When` cannot see a thread's state, so they would show on
  every thread. They are in `palette_test.go`'s and `keybindings_test.go`'s lists.
- **Discard also returns `first`.** The brief asked for the draft, the error and what was queued.
  A thread made by the CLI or an agent has no draft, and Edit would have lost its prompt.
- **`thread.remove` keeps its confirm**, whose "branches stay" is not quite so for a setup that
  never finished: a branch it made and nobody moved goes.

## Gotchas

- `exec.CommandContext` kills only git. With `Setsid` the group is git's, so `cmd.Cancel` kills
  the group. A killed `git fetch` used to leave `git remote-ext` and the remote's script running.
- `gitFetchBranch` (asking origin about a named branch) was a bare `exec` in the daemon's own
  process group: it goes through `ExecRunner` now. The other bare ones are local and short.
- A cancel can still take the runner's `WaitDelay`, 2s: seen once in a test, not reproduced in
  12 runs, and it looks like a child forked as the group was killed. So the tests check that
  the process is gone and allow that bound.
- `spawnStream` read `rec.s` without `m.mu`: a race the moment anything writes the record during
  a spawn, as a queued message does. It takes the thread now.
- A restart's `closeLostRun` clears `Queued` on items. `Manager.thread` puts it back for what is on
  the row, so a queued message still reads as queued after the restart.
- A daemon killed mid-add does not kill git, which is in its own session: it can finish, or
  clean up by itself and leave the branch. `undoAdd` deals with all of those.
- A lost blocking setup keeps its row until its projects have listed worktrees, Removing, for a
  moment in the snapshot after a start. If they never do within 2 minutes the thread goes without
  its cleanup, and the abandoned sweep is the backstop.
- Attachments are still reaped at 7 days, so a Try again or a draft after that finds them gone.
- The fake replays one capture, so a queued message stays `Queued` in its timelines: only real
  `command_lifecycle` frames clear the flag, by the same path as a message queued behind the
  handshake.

## For PRs 3 and 4

The exact surface is in the PR body. Two things not to assume: steps go back to pending, and a
retry changes `started_at`, so "Set up in 6.8s" is the last run's.

## Seen end to end

A `--dev` daemon on a scratch home with `HOME` under `/tmp`, `cmd/fakeclaude` first on `PATH` as
`claude`, a scratch repo and a bare remote; slow remotes through `ext::`, a slow checkout through
a smudge filter that sleeps.

- `--branch main` with the main checkout on it, `--background-setup`: failed at the worktree step.
  `thread restart` refused, ending "try its setup again first". After `git switch -c elsewhere`,
  `thread setup retry` at once: DONE, the name step kept, `#1 you`, then Claude's answer, one
  turn end, and Claude got the prompt once. Before the refresh above this failed the same way.
- Cancel after that: "it was too late to cancel it, and Claude is starting; interrupt it instead".
- A slow fetch: cancelled in 0.09s, idle `setup cancelled`, `thread wait` settled, one worktree,
  branch main only, nothing under the root, "Setup cancelled after 1.4s" from the two times.
  Retry from the start with a healthy remote: DONE.
- `git worktree add` half way, `locked initializing`, `cf/half` there: cancel killed the smudge
  filter, and the entry, the directory and the branch all went.
- A named branch's fetch: cancelled, and `ps` shows the remote script gone. Before the
  `ExecRunner` change the helper and the script outlived the cancel.
- Two messages during a slow fetch: `(queued)` in `thread read`; Claude got first, second, third.
- Sends while the main checkout still held the branch: each tried again and failed again, the
  timeline had one turn end, and `thread setup discard --json` gave `draftJson`, `error`, `first`
  and `queued`. `thread get` then said not found, with no tombstone in `thread list --all`.
- `kill -9` during a slow fetch with a message queued: failed, "Code Foundry restarted during
  setup" on both running steps, the message still `(queued)`. Retry: Claude got both, once.
- `kill -9` during a blocking create in `worktree add`: the client said "daemon connection lost",
  and git cleaned up its directory and left `cf/blocked`. The next start: no thread, one worktree,
  branch main only.
- A failed A with a worktree made, B on the same `--branch`: discarding A left the worktree and
  the branch, and B on it.
