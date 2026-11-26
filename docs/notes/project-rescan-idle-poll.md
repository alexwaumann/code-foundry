# Rescans refresh statuses again; per-worktree poll tiering

Branch `fix/project-rescan-and-idle-poll`, two commits: the rescan fix (part 1), then the
poll tiering (part 2), which relies on it.

## Part 1: a rescan or a config rewrite refreshed no status

Since #897 (`perf-project-sched-fetch-fsx.md`) `resolveBase` fans out a status job to
every worktree only when origin/<default> moved. Before it, every reconcile ended in
"base, then every status", and three event paths relied on that without saying so:

- **Rescans.** FSEvents dropping or coalescing events (`MustScanSubDirs`, `UserDropped`,
  `KernelDropped`, `RootChanged`, mounts) mapped to `jobReconcile` only. After #897 no
  status ran, so edits, HEAD moves and ahead/behind made while events were being dropped
  (a heavy install or build: `project-watcher-tests.md` measured 13 to 21 rescan
  batches in 15 s of churn) stayed stale until the next poll (5 or 15 min) or a thread's
  Touch.
- **config** (and `config.lock` created): `git branch -u`, `git push -u`, a remote
  change. A reconcile re-reads remotes but not upstreams, which only a status reads.
- **packed-refs** already had a patch in `onEvents` that queued every status.

Reproduced first with `rescan_test.go` against `53bdc30df`:

```
--- FAIL: TestRescanRefreshesStatus (8.87s)
    rescan_test.go:37: timed out waiting for the side worktree's edit after a rescan
--- FAIL: TestConfigRewriteRefreshesUpstream (5.72s)
    rescan_test.go:69: timed out waiting for the new upstream after a config rewrite
```

### The fix

`eventKeys` (watch.go) now returns the statuses with the reconcile, so the rule is in
one pure function and table-tested (`TestEventKeys`), and the `packed-refs` special case
in `onEvents` is gone (it is one of the three cases now):

- `packed-refs`, `config`, `config.lock` created in the common dir: reconcile and the
  status of every worktree of the project (from the routing table's worktree roots).
- A rescan (`rescanKeys`): reconcile every project with a known directory at, above or
  below the path, as before, and refresh the worktrees whose events may be lost:
  - a worktree root at or below the path: that worktree;
  - the path inside a worktree's tree (its nearest known directory above is the root):
    that worktree only, since dropped edits in its files change nothing else;
  - a git admin dir (common dir, logs, remote refs, `worktrees/`, a linked admin dir) at
    or below the path, or the path inside one: every worktree of the project, since a
    dropped `packed-refs`, `config` or remote-ref event can change any of them;
  - a project without git: the reconcile alone.

The spec asked for "every worktree of the affected projects". The narrowing above is
deliberate: the rescans seen under builds are either at a stream root (covering
everything anyway, or, at the managed worktree root, only the worktrees under it) or a
coalesced `MustScanSubDirs` on a busy directory inside one worktree
(`node_modules/...`), where refreshing all 41 siblings every 300 ms window would be the
cost #897 set out to remove.

### Cost

Per rescan batch, per covered project: the reconcile (as before; four small commands)
plus one `git status` (plus a memoized `rev-list` when HEAD moved) per refreshed
worktree. Rescan statuses go through the 300 ms git debouncer like the reconcile, so
under sustained rescans a worktree is refreshed at most once per 300 ms window (not the
1 s tree window: a rescan is not routed as a tree edit). Idle worktrees' statuses run at
low priority (`eventPrio`). A config rewrite costs one status per worktree; the
`config.lock` and the rename onto `config` normally fall in one debounce window. The
app's own `CreateWorktree` passes `--no-track` except when tracking `origin/<branch>`,
so it rewrites config only in that case.

## Part 2: per-worktree poll tiering

### Before

The backstop poll (`poll`, activity.go) ran per project: each round of a due project
requested a reconcile and a low-priority `git status` of every worktree. A project is
live when any of its worktrees is active (`worktreeActive`: a live thread, or a
`WorktreeDetail` watch in the last 10 minutes), so one live thread put all its sibling
worktrees on the 5 min cadence.

### Now

The poll has two halves, both run by the same loop (`tierLoop`, which gained an
optional `extra` pass and an injectable timer for tests):

- **Reconcile, per project** (`poll`), unchanged in cadence: 5 min when the project is
  live, 15 min otherwise. It re-lists worktrees and metadata, syncs the stream (retrying
  one that failed to start) and re-resolves the base.
- **Status, per worktree** (`pollWorktrees` over a `wtPollSched`, run after every
  round): a worktree is refreshed (low priority) once its status is older than its own
  tier's interval: 5 min for an active worktree, 15 min for any other, whatever its
  siblings are. "Older" is measured from the later of the worktree's last poll and its
  status's `RefreshedAt`, so a status refreshed by anything else (an fs event, Touch,
  TouchNow, Refresh; a base move only for active worktrees since
  `project-lazy-base-counts.md`) postpones its poll. The pass returns how long until
  the next worktree is due, and the loop sleeps until the sooner of that and the next
  project (at most the live interval).

Decisions and edge cases:

- **RefreshedAt plus a last-poll map, not the last poll alone.** Using the status's own
  time skips polls for worktrees that events keep fresh; the per-worktree last-poll
  time keeps the loop from spinning on a worktree whose status never sets
  `RefreshedAt` (a project without git is skipped outright; a status cancelled by
  shutdown).
- **Turning active.** `SetLiveWorktrees` gaining a path and a new detail watch already
  nudge the loop; the round that follows refreshes the worktree that turned active if
  its status is older than the live interval (as a project turning live was polled
  before), and only that worktree, not its siblings.
- **First poll after start.** Unknown worktrees are seeded with the loop's start, like
  the projects: Start's reconcile refreshes every status (the base goes from unset to
  resolved), so the first poll of an active worktree is 5 min after start and of the
  rest 15 min.
- **Worktrees added or removed between polls.** A new worktree gets its first status
  from the reconcile that finds it (`uninitializedStatusKeys`), then its own cadence
  from that `RefreshedAt`. Keys of worktrees and projects no longer present are dropped
  each pass.
- **Clock jumps and system wake.** Elapsed time is `elapsedSince` (the larger of the
  wall-clock and monotonic deltas), as for the project tiers: a forward jump or a sleep
  makes worktrees due early, at most once each; a backward jump cannot stall them (the
  monotonic delta still advances), and a last poll in the future makes the worktree due.
  A `RefreshedAt` in the future (a wall-only time after a backward jump) is ignored
  rather than trusted. After a sleep longer than 15 min every worktree is therefore
  polled once at the first round after wake, as before (the loop's timer is monotonic,
  so that round comes at most one live interval of awake time after wake; `onWake`
  still reconciles live projects and re-resolves their base at once).
- **The idle backstop stays.** Every worktree is still polled at least every 15 min:
  it is what covers a stream that failed to start, events lost without a flag (a
  replaced stream's last 250 ms), network volumes and reftable repositories.

### Measured

`TestIdleWorktreeGitCost` (poll_cost_test.go): one project with 1 live and 40 idle
linked worktrees plus the main checkout (10 of the linked ones with a commit of their
own), the store's real poll loop driven by a test clock and a step timer with the
default intervals (5 min / 15 min), one tick per simulated minute for an hour, no fs
event; counts from the counting runner. Before is this branch's part 1 commit with the
test seam alone (no behaviour change); after is this commit.

| One hour of polls | status | reconcile commands (worktree, remote ×2, symbolic-ref, base rev-parse) | total |
|---|---|---|---|
| Before | 492 (41 × 12) | 60 (12 rounds) | 552 |
| After | 172 (1 × 12 + 40 × 4) | 60 (12 rounds) | 232 |

The base move part of the test is unchanged by this commit (103 commands: 41 status,
41 rev-list, 11 rev-parse, 10 merge-tree); part 3 (`project-lazy-base-counts.md`) is
about it.

### What can be staler now

Only worktrees that are not active and sit in a live project: an fs event lost
*without* a rescan flag, or a change the stream cannot see at all (a stream that failed
to start, a network volume, a ref in a reftable store), now shows up within 15 min of
the worktree's last refresh instead of within 5 min. Everything else is as before:

- active worktrees: 5 min, unchanged;
- idle projects: 15 min, unchanged;
- any fs event the stream delivers (and, since part 1, any rescan) refreshes at once
  (debounced), whatever the tier; a thread's own edits refresh through Touch/TouchNow;
- the reconcile (new or removed worktrees, remotes, default branch) keeps the
  project's cadence;
- destructive decisions do not read the poll's results: `project.Cleanup` (the
  `cleanup` verb and archive cleanup) calls `Refresh` first, which waits for a
  reconcile, the base and every worktree's status; `RemoveWorktree` lets git refuse
  and re-reads the status; auto pull waits for its own base and status jobs.

## Tests

- `rescan_test.go`: `TestRescanRefreshesStatus`, `TestConfigRewriteRefreshesUpstream`
  (store, fake stream), and the `settle` helper (no armed debounce timer, nothing
  queued or running).
- `watch_test.go`: `TestEventKeys` gains the config, packed-refs and rescan cases.
- `activity_test.go`: `TestWtPollSchedRemaining` (table: seed, active, refreshed by an
  event, turning active, sleep, clock back, future refresh time), `TestPollWorktrees`
  (a fake clock and direct passes over a real store: tiers per worktree beside a live
  sibling, TouchNow postponing a poll, turning active, a worktree added and one
  removed between passes).
- `poll_cost_test.go`: `TestIdleWorktreeGitCost`, the measurement (skipped with
  `-short`).

## Gotchas

- A test that writes and then waits for a refresh must first let the fake stream's
  baseline events settle (`h.settle()`): otherwise a debounced status from the setup
  can run after the change and make a missing refresh look present.
- `tierLoop` ignores nudges until its first timer fires; tests that drive it with the
  step timer drain `pollNudge` after `SetLiveWorktrees` so the rounds they count are
  the ticks they fire.
