# Instant threads 1: the daemon core

PR 1 of 4. `ThreadService.Create` used to wait for the namer (up to 10s), the fetch (up to
20s), `git worktree add` per project and the spawn, and the composer waited on that one RPC.
Now Create has two stages and a caller may skip waiting for the second. Nothing sends the new
flag yet: PR 4 turns it on. Every caller today waits, and sees what it saw before.

## What changed

- `Create` is a fast stage, then a setup stage (`setup_run.go`). The fast stage refuses
  everything that needs no slow work (model, name, attachments, brief, creator, owner,
  `placeRequest`, `decidePlacement`, no git, a bad base or branch), then publishes the thread
  with its provisional name, writes the creator's note and the user's message, and starts
  the setup. `planThread` is the decision, `placeWorktrees` the carrying out; `placeThread`
  (Move) does both.
- `background_setup` on `CreateThreadRequest`: Create returns from the fast stage and the setup
  runs on a goroutine in `m.wg`, on a ctx that ends with Shutdown or a Remove, not with the RPC.
  Without it the same stage runs on the caller's goroutine, on its ctx. A failure removes
  what was made and the row, publishes `Removed`, leaves no tombstone and returns the same
  error as before.
- `Thread.Setup` (`setup.go`): phase, times, steps, `error`, and off the API `Made` and
  `Request`. Column `threads.setup`, JSON, migration 0058. Every Create has one, kept after a
  success with `Made` and `Request` dropped. Forks, residents and older rows have none.
- The namer and the fetch of a new branch's base run side by side: `project.Git.FetchBase`,
  then `CreateWorktree` with `Fetch: false`. Multi-project: one fetch per project, and each
  project's worktree starts as soon as the branch is named and its own fetch ended.
- `CreateWorktreeOptions.Progress` tells fetch and `git worktree add` steps as they happen.

## Decisions

- **State: reuse STARTING, with a reservation.** A new state would have meant a proto value,
  a GUI mapping and a case in every consumer. STARTING already reads as working everywhere:
  `threadBadge` says busy, `idleNow` is false so `thread.wait` does not settle, the Ember
  store's `working` is true, and `lib/ember.ts` reads through `threadBadge`. The reservation
  (`record.reserve`, as a stopped thread's start uses) is what makes it safe: without one,
  STARTING with no runner sends `running()` and `Send` into a hot loop, since `lifecycle` says
  stopped and `startStopped` says not stopped. With it, whatever waits on a start waits on the
  setup. Status is BUSY `setting up`.
- **After a failure: DISCONNECTED, ERROR `setup failed`.** `DisconnectReason` is the same,
  `LastError` and `Setup.Error` say why. ERROR sorts with the threads that want the user and
  settles a wait. The failed setup closes its message's turn with a synthetic turn end: that
  is what `thread.wait` counts as a reaction, so no change to the handler. `waitStatus` adds
  the reason to the CLI's line. No error item is written: the failed step is the thread's
  failure display, and PR 3 would have had to hide a second one.
- **`Setup` ends in spawn's commit**, with the process and the reservation, so there is never a
  running process with a running setup. It does not wait for the handshake. A thread that
  dies before its handshake keeps today's path: its error item, status `did not start`, and
  the next message tries again. Waiting for the handshake would have turned a daemon death in
  that second or two into a failed setup that a send cannot get past, undoing what
  `firstprompt.go` is for.
- **The start step therefore covers the spawn, not Claude's first answer.** "Set up in 6.8s"
  excludes the handshake.
- **`Made` and `Request` live in the same column, off the API.** A running or failed setup
  serializes the request on every save, which is small next to what `saveThread` writes
  anyway, and a success drops it. `Request` holds only what the row does not: placement,
  prompt, attachments, notify, name, draft. `draft_json` is capped at 1 MiB.
- **Steps that turn out to have nothing to do leave the list** rather than gaining a "skipped"
  status: a fetch of a tag or a sha, a repository without origin, an existing local branch, a
  worktree that exists. So a pending fetch can vanish. PR 3 should not assume the list only
  ever changes status. Off fetches nothing, so it never lists one.
- **The age in a fetch warning is the commit time of the ref's tip**, not when it was last
  fetched: git keeps no such time for a packed ref, and a fetch that changes nothing writes no
  reflog. "using origin/main from 2h ago" is then how old the code is, which is the point.
- **A fetch step's `ref` is a guess until it starts**: `origin/<base>`, corrected or dropped
  once the project store has classified the base.
- **Archive waits for a setup; Remove stops it.** Archive has no way to say what a cancelled
  setup's thread is until PR 2's `cancelled`, and the wait is bounded by the fetch and the RPC's
  ctx. Remove cancels and waits, so no goroutine outlives the record. In the background path
  it also takes what the setup recorded as made, since nothing else knows those worktrees;
  in the waited path the caller's rollback does.
- **A spawn does not start for a thread being removed**, even when the placement finished: the
  check is on `Removing`, not on ctx, so a client that cancels at that moment behaves as it
  did.
- **Refusals.** `Send`, `Reconnect` (and any start, in `startStopped`), `Fork`, `RunIn`,
  `AddProject`, `RemoveProject`, `Move`, `Reseed` and a `like` of an unplaced thread are refused
  while a setup runs and after it failed. `Snooze`, `SaveForLater`, `SetEffort`, `SetModel` and
  `SetPermissionMode` only while it runs, since spawn may be reading the row; after a failure
  they go to the row, as for any stopped thread. `Interrupt` and `Restart` do nothing while it
  runs. `Rename`, `Pin`, labels, budget and the like work in any state: a rename during setup
  beats the namer, as ever.
- **`CheckoutsOf` is empty for an unplaced thread**, rather than resolving members to the
  project's own checkout. That covers `Checkouts`, hints, `otherHolder`, the cleanup and branch
  link rules. `threadPlace` says no (actions), `terminal.new` refuses, `fillPending` skips it.
- **Args.** `background-setup` and `draft-json` follow `composer-prompt`: plain args marked
  "the GUI sets it". The registry has no hidden flag, and adding one for two args was not worth
  it. A CLI user can pass them; the message then says the thread is being set up.

## Hints

`res.Hints`, `made_worktree`, `made_branch`, `existing_worktree`, `shared_with` and
`worktree_mode_dropped` are computed after placement. With `background_setup` the reply leaves
them empty, even for a checkout-mode thread whose hints could be known. The composer shows
collision hints before sending (`lib/collisionHints`, `CheckPlacement`), so nothing is lost.

## Gotchas

- `CreateWorktreeOptions` is no longer comparable: `Progress` is a func. Three recreate tests
  compared it with `!=`; they use `reflect.DeepEqual` now.
- A thread's `WorktreePath` can be empty now. The consumers were checked; the ones that needed
  it are `projectactivity` (a synthetic turn end would have called `Touch("")`), `threadPlace`
  and `shellOwner`. `samePath("", x)` in the thread store cleans "" to ".", so do not add a
  path comparison on an unplaced thread.
- The blocking path shows the thread in the GUI during the wait, as agreed, with no worktree
  path. If its Create fails the row goes with a `Removed`.
- `finishSetup` leaves a background setup's row running when the daemon is stopping, and the
  next `New` fails it. So a clean stop and a crash look the same afterwards.
- A setup the daemon lost is marked failed in `New` before the block that handles lost
  threads, which would otherwise read it as a stopped thread whose first message goes at the
  next start. A failed setup never starts by itself.

## For PR 2

- `Setup.Made` has `project_id`, `path`, `branch`, `new_branch`, `start_point`; `madeOf` turns
  it into what `rollback` takes. A thread removed after a failed setup leaves its worktrees for
  now: `Remove` during a run cleans up, `Remove` after a failure does not.
- `Setup.Request` has no `options()` yet: retry needs to rebuild `CreateOptions` from it and
  the row. A `Like` may be gone by then, and `Request.Like` then fails at the plan again.
- `PendingFirst.Prompt` holds the rewritten prompt once the placement landed. Retry should
  rebuild it from `Request` (`buildPrompt`), and the item stays under `PendingFirst.ItemID`.
- A retry after a failure needs a fresh `reserve`, `setupJob` and turn. The failed run's
  synthetic turn end is in the timeline after the user's message.
- `record.namingTried` is reset at a restart for a thread not named for good, so a retry would
  run the namer again. A late title that missed the failure is dropped: `applyLateName` only
  runs after a spawn.
- A failed setup's `failed` step and the rest stay as they ended; a retry has to reset them.
- `setupRefusal` is the one place that words the refusals.

## Seen end to end

A `--dev` daemon on a scratch home with `HOME` under `/tmp`, `cmd/fakeclaude` first on `PATH`
as `claude`, a scratch repo and a bare remote. A slow remote is `ext::` to a script that
sleeps 6s before `git-upload-pack`. The fake answers the namer with nothing usable, so the
branches below are all the `cf/<id>` fallback.

- `thread new --new-worktree`, healthy remote: 0.2s, setup DONE, steps name, fetch, worktree,
  start, all done.
- `--background-setup`, slow remote: returned in 56ms with STARTING, BUSY `setting up`, no
  worktree path, and `thread read` already showing `#1 you: ...`. At 1s the fetch step was
  RUNNING and the worktree and start steps PENDING. `thread send` said "is still being set
  up", and `thread wait --for 1s` timed out with "it is busy (setting up)". DONE 6.3s later.
- The same remote without the flag: the CLI returned in 6.3s, its reply as before.
- Unreachable remote, blocking: the thread was created, its fetch step WARNING "Could not reach
  origin" with git's `fatal: '...' does not appear to be a git repository` and `ref_at`.
- `--branch main` (the main checkout is on it), blocking: an error, thread count 5 before and
  after. With `--background-setup`: a thread with `error (setup failed)` in `thread list`, the
  worktree step FAILED, and `thread wait` returned at once with the reason.
- `kill -9` of the daemon during the slow fetch, then a new daemon: DISCONNECTED, ERROR
  `setup failed`, "Code Foundry restarted during setup" on the running fetch step, later steps
  PENDING, the turn closed in `thread read`. `thread remove` took it.
