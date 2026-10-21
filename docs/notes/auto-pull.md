# Auto pull the default branch

Status: done on `cf/auto-pull` (one PR of the branch naming + auto pull series).
`make check` is green. Run end to end on 2026-10-20 with a scratch daemon (see "End to
end" below).

## What changed

A setting `projects.auto_pull` (Bool, default on, Source control › Projects, next to
the fetch interval). After each scheduled fetch of a **live** project, once its
statuses are refreshed, every checkout of the project (main checkout or worktree) that

* is on the project's default branch (not detached),
* tracks an upstream it is behind and not ahead of,
* has nothing staged, modified or conflicted (untracked files are fine),
* has no git operation in progress and no status error,
* and is not busy: no thread on a turn there, no running action, no queued or running
  gitops op,

is fast-forwarded with `git pull --ff-only` through the gitops store, titled
`Auto pull origin/main`. The op shows in the worktree panel's op strip and in gitops
history like a user's pull; gitops logs it at Info as every op.

## Design

**Project store (`internal/store/project/autopull.go`).** The store picks *when* and
*which*; the daemon says *whether* and *how*:

* `Status.CanFastForward()` is the per-checkout git predicate. `HasUncommitted` is too
  strict (it counts untracked files, which is what `git worktree remove` refuses).
* `AutoPullCandidates(Project)` adds the default-branch rule (and skips projects in
  error, without git, or with no known default branch).
* `SetAutoPull(AutoPull{Enabled, Busy, Pull})` is the hook, set by the daemon once the
  thread, action and gitops stores exist (so no closure reads a store field while
  `openStores` is still assigning it). It is a method on `*Git` only, like the
  live-worktrees hook; `projecttest.Fake` does not need it.
* `fetch` now ends in `afterFetch`. When auto pull is off, the project is idle, or the
  project's previous pass is still running, it requests the reconcile as before. Else a
  pass runs on the store's wait group: `refresh` (reconcile, base, every status,
  waited for, bounded by the fetch timeout), then for each candidate `Busy` then
  `Pull`, one at a time. A successful pull is followed by `TouchNow` on the checkout.
  gitops also refreshes the project after every pull, so this is belt and braces for
  the checkout that moved.
* The pass runs off the fetch loop: a pull can take up to gitops' 3 min pull timeout and
  must not hold up other projects' fetches. At most one pass per project, and the
  fetch loop skips a project while its pass runs (see Gotchas).

**Daemon glue (`internal/daemon/autopull.go`).** `autoPullHooks` builds the hooks:

* `Enabled` reads `projects.auto_pull` from the settings store at each fetch, so a
  change applies from the next fetch without a restart.
* `Busy` is `checkoutBusy` over the current thread, action and gitops snapshots. A
  thread counts only when its status is `StatusBusy` (on a turn), not merely connected.
  `StatusNeedsAttention` does not count: it survives a disconnect and a daemon restart,
  so a thread left on a permission prompt would block its checkout indefinitely. A
  running action counts in either mode (a terminal dev server too). A queued or
  running gitops op counts, so an auto pull never queues behind (or runs right after)
  the user's own op on the same lane. Paths are compared cleaned, resolving the other
  side's symlinks only when they differ, and only for entries that are busy at all.
* `Pull` calls `gitops.Pull` with `Rebase: false` and the new `PullOptions.Title`
  (`"Auto pull " + upstream`). A failed op becomes an error carrying its summary.

## Decisions

* **Live projects only.** The idle tier (15 min) fetches projects nobody works in; they
  are left as they are. A project that turns live is fetched at once (activity tiers),
  so its default-branch checkouts are pulled the moment a thread starts or a worktree
  panel opens.
* **Untracked files do not block.** A fast-forward never touches untracked files: it
  only writes files that the incoming commits add or change. The one conflict, an
  untracked file at a path an incoming commit adds, is refused by git itself
  ("untracked working tree files would be overwritten by merge") without touching
  anything. Blocking on untracked files would stop auto pull in most real checkouts
  (scratch notes, build output not in `.gitignore`) for no safety gain. A *staged* new
  file is staged and blocks.
* **A refused pull is just a failed op.** The pass logs `auto pull refused; retrying
  after the next fetch` at Info with git's summary, and the next fetch's pass tries
  again. No backoff beyond the fetch interval: a pull that keeps failing costs one
  `git pull` per fetch interval (2 min by default) and shows as a failed op each time,
  which is also how the user notices the untracked file in the way.
* **Never rebases.** `--ff-only` only; a checkout with commits of its own is not a
  candidate at all.
* **Off with fetching.** `projects.fetch_interval_seconds = 0` stops the fetch loop, so
  nothing is pulled either; the description says so.

## Gotchas

* A scheduled fetch must not run under an auto pull. `git pull` fetches too, and two
  fetches writing the same `FETCH_HEAD` made the pull fail with "Cannot fast-forward to
  multiple branches" (`make check` caught it: the end-to-end test fetches every 150 ms).
  `fetch` now returns early while the project's pass runs; the project is fetched on
  its next due round. A user's own fetch or pull through gitops can still overlap a
  scheduled fetch, as before this change.
* The busy check and the pull are not atomic: a thread could start a turn between them.
  The pull is a fast-forward over a clean checkout, so at worst the agent sees the new
  commits appear; the same can happen with any user pull.
* Ignored files are not protected. Git treats them as expendable: an incoming commit
  that adds a file at an ignored path overwrites the local copy, with no refusal (checked
  with a scratch clone). Any `git pull` does the same; auto pull just does it unasked.
  Untracked, non-ignored files are protected (the pull is refused, nothing written).
* `refresh` re-requests base and status jobs that the reconcile also requests, so a
  pass can run a project's statuses twice. That was already true of gitops' refresh
  after every op; the cost is one `git status` per worktree per fetch.
* A pass waits for the refresh rather than reading the snapshot right after the fetch:
  the fetch moves `origin/main`, and only a fresh status knows the checkout is behind.

## Tests

* `internal/store/project/autopull_test.go`: `TestCanFastForward` (every condition
  toggled; untracked allowed, a staged new file blocks), `TestAutoPullCandidates` (only
  the default branch, detached, dirty, no default branch, project in error or without
  git), `TestAutoPullPass` (real store and fetch loop: nothing while off, idle or busy;
  a refused pull retried after the next fetch; then fast-forwarded, and no further
  pulls with nothing to pull).
* `internal/daemon/autopull_test.go`: `TestCheckoutBusy` (busy thread, through a
  symlink, idle and needs-attention threads, running and exited actions, queued,
  running and finished ops), `TestAutoPullHooksPull` (gitops fake: a pull without
  rebase, a failed op is an error), `TestAutoPullEndToEnd` (real project and gitops
  stores, a scratch origin and three clones: nothing while off; clean fast-forwarded
  with one `Auto pull origin/main` op; dirty left behind; busy pulled once its turn
  ends).
* `internal/store/gitops/store_test.go`: `PullOptions.Title` replaces the title.
