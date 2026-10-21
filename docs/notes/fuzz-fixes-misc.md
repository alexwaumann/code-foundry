# Fuzz fixes: GitHub, terminals, actions, Ember

Fixes from the 2026-10-21 fuzz pass (misc report findings 1-7, api report finding 5).

## Ember

- A failed consolidation no longer moves `LastConsolidatedAt`. The next boundary reads
  everything since the last good one; `ConsolidationInput` already caps the input at
  300 KiB (oldest messages go first), so a run of failures cannot grow it without bound.
  No "epochs not consolidated" counter: `LastConsolidationError` already says it failed.
- `ember.task.start` finishes its bookkeeping (link the worker, or cancel the task when
  thread.new failed) on `context.WithoutCancel` with a 10 s timeout. A caller that went
  away no longer leaves a task doing with no worker.
- `EmberService.WatchBoard` sends a heartbeat after 5 s of silence. The proto gained
  `EmberBoard.heartbeat` instead of a wrapper message, so the stream type stays the same; a
  heartbeat carries no status and no tasks. `watchEmberBoard` yields `HEARTBEAT` for it,
  which arms `runStream`'s liveness watchdog.

## GitHub

- `pollFailed` treats an error as store-wide only when the store actually paused or is
  in auth mode. A 200 answer without a viewer decodes as `ErrNotAuthenticated`, but
  `callDoc` saw a success, so nothing paused, and the worker used to poll again at
  MinGap. It now backs off like any failed poll.
- Auth recovery: the wait between auth checks is capped at 2 minutes (was 15).
  `HTTPRunner` remembers the token GitHub last answered 401 to; `AuthStatus` asks the
  local gh for its token on every check, but sends `GET /user` only for a different
  token, or for the same one after 15 minutes. `Refresh("")` and a presence rise set
  `authNext` to now.
- Renamed or transferred repositories: every repository block of the poll selects
  `nameWithOwner`. When it differs from the tracked slug, the snapshot records
  `RepoState.CanonicalSlug`, and `Snapshot.LocalRepo` maps the new name back to the
  slug. The API's dashboard and recently merged lists, and the store's
  `CachedPullRequest(s)` (thread branch links), carry pull requests under the tracked
  slug. GraphQL follows the rename, so opening one by the old slug works. The alias is
  not persisted; the first poll after a restart learns it again. Nothing in the GUI says
  "moved" yet (follow-up).

## Terminals

- `actor.kill` reads the PTY's foreground process group (TIOCGPGRP through
  `SyscallConn().Control`, never `Fd()`, which would make the master blocking). It hangs
  up that group too, then sends SIGCONT so a stopped job sees the hangup, and records
  both groups.
- The SIGKILL escalation is now a `time.AfterFunc` that only sends signals. It is not
  stopped when the terminal exits or is removed: `KillAndRemove` removes the terminal as
  soon as the shell dies of the hangup, and the escalation must outlive that. It kills
  each recorded group that still has a member (`kill(-pg, 0)`). `Manager.Close` waits
  while a recorded group is alive (up to KillGrace) and then kills the leftovers itself,
  because the daemon exits before the timer would fire.
- A pid could in principle be reused within the 3 s grace. A group that has fully exited
  is skipped by the existence check; a reused pid that leads a new group in that window
  is accepted as negligible.

## Actions

- `ActionService.StopRun` / `action.stop <run>`. A background run gets the existing
  `runRec.kill` (SIGTERM, SIGKILL after the grace). A terminal run kills its terminal; a
  terminal already gone finishes the run with ExitUnknown. Stopping a finished run returns
  it unchanged. The palette gets the command via the registry (run id completion). The
  GUI has no running-run rows to put a button on (background runs only appear in the
  failed-setup dialog), so a stop control there is a follow-up.
- `action run --wait`: when the caller goes away (Ctrl-C, or a tool call timing out
  ends the Invoke request's ctx) before a background run it started finishes, the
  command stops that run. A terminal run is left alone: it is on screen and closes with
  its tab. `action wait <run>` never stops anything; its description says so.
- Worktree hooks: each on-worktree-create run gets `Options.HookTimeout` (10 minutes).
  After that it is stopped, the wait goes on until it has ended (at most the kill
  grace), and the next hook starts.

## Verified

- Unit tests: ember (the failed epoch's messages reach the next prompt), command
  (cancelled ctx in task start; `--wait` interrupt stops background runs only),
  gh (no-viewer backoff, auth check now, auth backoff cap, AuthStatus skip, renamed
  repository through the fake GitHub), api (dashboard and repo activity under the
  tracked slug; WatchBoard heartbeats in the shared heartbeat table), terminal (a zsh
  job that traps HUP dies on Kill, KillAndRemove and Close, under -race), action
  (StopRun for both modes, hook timeout), frontend (`watchEmberBoard` maps heartbeats).
- End to end on a scratch daemon: interrupting `action run --wait` left no
  `sleep` behind (run `exited 143`); `action wait` interrupted left the run going, and
  `action stop` ended it; a terminal run stopped with 129. A `trap '' HUP; exec sleep`
  job in an interactive zsh died on `terminal kill` and on daemon SIGTERM ("process
  ignored SIGHUP, sending SIGKILL" with the job's pgid in the log).
