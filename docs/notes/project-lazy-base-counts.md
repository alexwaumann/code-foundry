# Lazy base counts: no git status for inactive worktrees when origin/<default> moves

Branch `perf/project-lazy-base-counts`, stacked on `fix/project-rescan-and-idle-poll`
(`project-rescan-idle-poll.md`).

## Why

When origin/<default> moved, `resolveBase` requested a status job for every worktree,
because base ahead/behind and the merged-by-content check are computed inside it
(`baseCounts`, base.go). For 1 live and 40 idle worktrees that was 41 `git status`, 41
`rev-list` and a `rev-parse` + `merge-tree` for each diverged non-main worktree, on
every base move (every fetch that brings new commits to the default branch).

A base move cannot change a worktree's dirty state. It changes:

- the base comparison: `BaseRef`, `BaseAhead`, `BaseBehind`, `BaseMerged` (and so
  `Landed()`, which cleanup eligibility and archive cleanup read);
- **the upstream ahead/behind of a worktree whose upstream is origin/<default> itself**
  (the main checkout, nearly always). The brief did not list this one; three existing
  tests (`TestWorktreeLifecycleAndWatcher`, `TestPeriodicFetch`, `TestAutoPullPass`)
  caught it on the first version, which updated only the base fields. It is the same
  comparison (`HEAD...origin/<default>`), so it is set from the same counts.

## What changed

| File | Change |
|---|---|
| `basecounts.go` (new) | `jobBaseCounts` (one per project, low priority): for every worktree not given a status for this move and whose memo is not against the current (HEAD, base), compute the comparison without `git status` and store and publish it. One `git for-each-ref --format=%(refname)%00%(objectname)%00%(ahead-behind:<base>) refs/heads/<b>...` for the worktrees on a branch whose ref is at their published HEAD (git 2.41+); `rev-list --left-right --count` per worktree otherwise (detached HEAD, a ref that moved since the status, an older git). For a diverged worktree other than main, `mergedByContent` runs before anything is published. `WorktreeUpdated` only when the published status changed. |
| `base.go` | `resolveBase`: on a move (not the first resolution, and not to "no base"), statuses for active worktrees (`worktreeActive`) and uninitialized ones, as before, and `jobBaseCounts` for the rest; it records that split (`lazyBase`) so each worktree is covered by exactly one of the two jobs even if it turns active between them. The first resolution after start and a base that goes away still refresh every status. |
| `store.go` | `wtSlot.mu`, held by the status job for its whole run; `projectState.lazy`; `Git.aheadBehindUnsupported`; `runJob` case. |
| `sched.go` | the `jobBaseCounts` kind. |
| `merged.go` | comment: who runs the check now. |

### Ownership of the slot

`slot.cur` and `slot.base` (the memo) were documented as written only by the status
job, and the scheduler made that true (one run per key). `jobBaseCounts` is another key,
so the two would race: it could store a comparison over a status published a moment
before (losing the new dirty counts), or a status that read the old base could publish
over the new comparison with nothing left to correct it.

So the slot has a mutex. The status job holds it for its whole run; `jobBaseCounts`
only *tries* it, for a short critical section (re-check, store memo and cur):

- lock taken: it re-checks that the slot is still the project's, its published HEAD is
  the one it compared, there is no status error, and the project's base is still the
  one it compared with (a newer move requests the job again); then it stores the memo
  and the worktree, and publishes after unlocking (`commit` rebuilds from the slots, so
  publish order cannot regress them);
- lock busy (a status job is running for that worktree, which may have read the old
  base): it requests a status for it instead, low priority. It never waits on git.

What it stores is exactly what `baseCounts` would compute for the same (HEAD, base),
including `mergedChecked` (main: not checked when diverged, as in the status job), so
the next status run hits the memo and publishes the same values. `TestLazyBaseCounts`
checks that a full `Refresh` after the lazy pass computes the same status for every
worktree (all fields but `RefreshedAt`) and runs no `rev-list` or `merge-tree`.

A worktree whose last status failed (`Status.Error`) has no comparison to update; the
job requests its status at low priority instead, so a base move still retries a failed
status as the status-every-worktree move did (`TestLazyBaseCountsRetriesFailedStatus`,
a review finding). A worktree with no status yet already has one requested by
`resolveBase`, and an unborn HEAD has nothing to compare.

A worktree dropped meanwhile (by a reconcile, or by `dropUndoneWorktree` when
CreateWorktree undoes itself, #911) is never written: the job re-checks under the slot's
lock that the project still holds that slot, and a store racing with the drop lands in
an orphaned slot nobody reads (`commit` rebuilds the snapshot from the project's slots,
and no event is published for a worktree the snapshot no longer has).

`RefreshedAt` is left alone: the dirty state was not re-read, and the per-worktree poll
(`project-rescan-idle-poll.md`) measures from it.

### Old git

`%(ahead-behind:)` needs git 2.41. When for-each-ref fails with a message naming it,
`aheadBehindUnsupported` is set once and every later pass goes straight to `rev-list`
per worktree, still without `git status` (`TestLazyBaseCountsOldGit`). Any other
for-each-ref failure falls back for that pass only. A rev-list failure requests the
worktree's status, which decides what a failed comparison publishes, as before.

## Measured

`TestIdleWorktreeGitCost` (poll_cost_test.go, unchanged scenario: 1 live + 40 idle
linked worktrees + main, 10 linked ones with a commit of their own, the live one among
them), part (b): origin/main moves by one commit, fetched outside the store, the fetch's
events delivered. Counts from the counting runner.

| One base move | status | rev-list | for-each-ref | rev-parse | merge-tree | total |
|---|---|---|---|---|---|---|
| Before (branch 1 tip) | 41 | 41 | 0 | 11 (1 base + 10 merge checks) | 10 | 103 |
| After | 1 (the live worktree) | 1 (the live worktree) | 1 | 11 | 10 | 24 |

These numbers are for the fetch alone. The test's fetch now runs with auto maintenance
off: on git 2.54+ the fixture's 41 loose branch refs make the same fetch pack the refs,
which (until `project-packed-refs-upstream-check.md`) refreshed every worktree's status
on top of this and made the test fail on CI's git 2.56.1 (112 commands, 44 status).

The merge checks stay (10: the 9 idle diverged worktrees in `jobBaseCounts`, the live
one in its status): they are what keeps `Landed()` right. Part (a), an hour of polls,
is unchanged (232 commands; a poll's status reuses the memo).

## What can be staler now

- **Nothing about dirty state**: a base move never refreshed it for a reason of its own.
  Before this change an inactive worktree's base move status happened to re-read its
  files too, so a missed fs event could be caught by a fetch; now that falls to the
  poll (15 min for an inactive worktree) or the next event, as for any other missed
  event.
- **The base comparison of an inactive worktree** is published when `jobBaseCounts`
  finishes, at low priority, as the status jobs it replaces were. Until then the old
  comparison is shown, never a half-computed one: the merge check runs before the
  publish.
- **Destructive decisions** do not depend on it: `project.Cleanup` (the cleanup verb and
  archive cleanup) runs `Refresh` (every worktree's status, waited) first; auto pull
  waits for the default branch worktrees' status jobs; `RemoveWorktree` lets git refuse
  and re-reads the status.

## Tests

- `basecounts_test.go`: `TestLazyBaseCounts` (branch, detached, main, diverged, landed
  by content; one status and one for-each-ref per move; main's upstream counts; a full
  Refresh agrees and reuses the memo; a pass with nothing to do runs no git; a recomputed
  unchanged comparison publishes nothing), `TestLazyBaseCountsOldGit`,
  `TestLazyBaseCountsBusySlot` (slot held as by a running status: a status request
  instead, then the right comparison), `TestLazyBaseCountsRetriesFailedStatus` (fails
  without the retry), `TestParseAheadBehind`.
- `perf_opt_test.go`: `TestResolveBaseUnchangedSkipsStatusFanout` and
  `TestFetchCoalescesWatcherBurst` now expect no status for idle worktrees on a base
  move, and every worktree's `BaseBehind` moved (one for-each-ref).
- `poll_cost_test.go`: part (b) asserts the counts above and every idle worktree's base
  fields.

## Gotchas

- `for-each-ref` patterns match a ref "from the beginning up to a slash", so passing
  `refs/heads/a` also lists `refs/heads/a/b`; results are keyed by full ref name, so
  the extra lines are ignored. Ref names cannot contain `*`, `?` or `[`, so a branch
  name is never a glob.
- The lazy pass must skip exactly the worktrees `resolveBase` gave a status, decided
  once per move. Deciding "active" again when the job runs either duplicated the live
  worktree's work (its status running meant a failed TryLock and a second status) or
  left a gap (a worktree that turned active in between got neither).
