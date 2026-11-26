# packed-refs and config rewrites: one upstream check, not a status of every worktree

Branch `fix/project-base-move-newer-git`. Follows `project-lazy-base-counts.md` (#917)
and `project-rescan-idle-poll.md` (#913).

## The failure

Main's sweep for `8d9fcbf84` failed `TestIdleWorktreeGitCost` on the macOS runner
(Homebrew git 2.56.1):

```
one base move, 1 live + 40 idle worktrees: for-each-ref=1 merge-tree=10 remote=2 rev-list=41
  rev-parse=12 status=44 symbolic-ref=1 worktree=1 (total 112)
```

The developer machine passed with 24 commands because Homebrew git 2.52.0 is first in
its `PATH`. Reproduced locally with git 2.56.1 built from the kernel.org tarball into a
private prefix and put first in `PATH` for the test only (107 commands, status=43). With
the fake stream's batch printed, the fetch on 2.56 reported, beside `FETCH_HEAD`, the
origin/main reflog and `refs/remotes/origin/main`:

- `.git/packed-refs` created;
- every loose ref removed: `refs/heads/main`, `refs/heads/wt-00` ... `wt-39`,
  `refs/remotes/origin/main`.

On 2.52 the same fetch reports only `FETCH_HEAD`, the reflog and the written
`refs/remotes/origin/main`.

## Cause

Git 2.54 made `geometric` the default maintenance strategy ("git maintenance starts
using the geometric strategy by default", RelNotes 2.54.0). Auto maintenance, which
`fetch`, `commit`, `merge`, `rebase`, `am` and others run after their work
(`git maintenance run --auto --quiet --detach`, `prepare_auto_maintenance` in
run-command.c), now includes the `pack-refs` task, whose auto condition
(`should_pack_refs`, refs/files-backend.c) is met when the loose refs reach
`max(16, 5 * log2(packed-refs size / 100))`: 16 with no packed-refs, 33 at 10 kB, 49 at
100 kB. `pack-refs` is a foreground task (`.foreground = maintenance_task_pack_refs`,
builtin/gc.c): it runs `git pack-refs --all --prune --auto` before maintenance
detaches, so it finishes before the fetch returns. Not a race; deterministic once the
loose refs pass the threshold. Seen with `GIT_TRACE=1 git fetch`:

```
run_command: git maintenance run --auto --quiet --detach
run_command: git pack-refs --all --prune --auto
```

Apple's git 2.54.0 (Apple Git-157) does the same (a repository with 20 loose branches is
packed by `git maintenance run --auto --no-detach`; Homebrew 2.52 leaves them loose), so
the developer machine would fail too with `/usr/bin/git` first. Before 2.54 the `gc`
strategy packed refs only inside a full `gc --auto` (6700 loose objects or 50 packs).

How the events routed (watch.go, fsevents.go):

| Path | Route |
|---|---|
| `<common>/packed-refs` created | `actReconcile` and, since #913, the status of every worktree: 41 statuses, each with a `rev-list` since the base had moved |
| `<common>/refs/heads/*` removed | below the common dir, not a direct entry: nothing |
| `<common>/refs/remotes/origin/main` removed | `jobBase` (the base move, as on 2.52) |
| `<common>/refs/remotes/origin/<branch>` removed (a worktree tracking a pushed branch) | `remoteRefFor`: a status of each worktree on or tracking that branch |

So a pack-refs rewrote no ref's value and still cost every worktree a status; with a base
move in the same fetch the lazy path of #917 ran and was then overtaken by the status of
every worktree (the 3 extra statuses were reruns of slots busy when the event's statuses
were requested).

## Product or test

Both, the product first. In a fleet the loose refs pass the threshold often: every
branch an agent creates or commits to after the last pack is a loose ref, as is every
remote-tracking ref a fetch updates; then the next fetch, commit, merge or rebase in any
of the project's worktrees packs them, and before this change that re-ran `git status`
in every worktree. The saving #917 was merged for did not hold on git 2.54+ for any fetch
that also packed, and #897's "a no-op fetch costs 2 commands" did not hold for such a
fetch either (it cost a reconcile and a status of every worktree).

The test was also version-dependent: its fetch measured "a base move" on 2.52 and "a base
move plus a pack" on 2.54+.

## What changed

Option (b) of the brief: a rewrite that changes nothing a status shows refreshes
nothing.

| File | Change |
|---|---|
| `upstreams.go` (new) | `jobUpstreams` (per project): one `git for-each-ref --format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket) refs/heads/<b>...` for every worktree on a branch, compared with each published status: branch ref at the published HEAD, same upstream name, same ahead/behind (gone = 0/0, as `git status` reports a gone upstream with no `branch.ab`). A worktree that differs gets a status (`eventPrio`). Detached worktrees have no upstream and are skipped; a failed or unborn status gets a status; a failed for-each-ref refreshes every branch worktree, as before. A worktree whose upstream is the base ref compares only the name and HEAD: its counts are the base jobs' (`applyBaseCount`), which may not have run yet for a base that moved in the same fetch. |
| `watch.go` | `eventKeys`: `packed-refs`, `config`, `config.lock` created → reconcile and `jobUpstreams` (was reconcile and the status of every worktree). The reconcile stays: config carries remotes, and the default-branch fallback reads `main`/`master`, which a packed-refs rewrite can delete. |
| `fsevents.go` | A removed non-default loose remote-tracking ref → `jobUpstreams` (was a status of each worktree on or tracking it). `fetch --prune` of a loose ref and `pack-refs --prune` both remove the file; only the first changes anything. A written one still refreshes those worktrees directly. |
| `sched.go`, `store.go` | the job kind, `runJob` case. |

### Racing a running status

Each slot is compared under `slot.mu`, which the status job holds for its whole run. A
status running when the check reaches it may have read the refs before the rewrite and
publish that after the check read them, so the check waits for it (busy slots last) and
compares what it published: a stale result differs from the refs read and gets a status,
a current one is not run again. The first version requested a status for every busy slot
instead, as `jobBaseCounts` does; that re-ran the live worktree's base-move status in
the cost test (31 commands, status=2, rev-list 1). Waiting cannot deadlock: only a
running status job (or `applyBaseCount`'s short critical section) holds the lock, and
neither waits on another job. It costs the check's worker one status's time.

### Not taken

- **(a) `-c maintenance.auto=false` on the store's own fetches.** Not needed for cost
  after (b), and it would not cover the commits, merges and rebases agents run in every
  worktree, nor the user's own fetch in a terminal, which trigger the same pack. It would
  also move the repository's housekeeping (geometric repack, pack-refs, commit-graph)
  off the app's fetches, which for an idle project are the only git commands that run.
- **Mapping packed-refs to `jobBase` instead of a reconcile.** Saves 4 commands; but the
  default-branch fallback (no origin/HEAD) checks `main`/`master`, which a packed-refs
  rewrite (`git branch -D main` of a packed ref) can delete.

## Measured

`TestIdleWorktreeGitCost`, 1 live + 40 idle worktrees (10 diverged), counts from the
counting runner, 5 runs each on Homebrew git 2.52.0 and on git 2.56.1 (private build),
identical every run. The test now has four parts; (b) fetches with
`-c maintenance.auto=false` so it measures the base move alone on every git, and (c)
packs the refs explicitly (`git pack-refs --all --prune`, what maintenance runs).

| | 2.52 before | 2.52 after | 2.56 before | 2.56 after |
|---|---|---|---|---|
| (a) an hour of polls | 232 | 232 | 232 | 232 |
| (b) base move, fetch alone | 24 (status 1) | 24 (status 1) | 24 (status 1) | 24 (status 1) |
| (c) pack-refs | 47 (status 41) | 7 (status 0, for-each-ref 1, reconcile 5, base rev-parse 1) | 47 (status 41) | 7 |
| (d) no-op fetch, maintenance on, refs packed | 1 (rev-parse) | 1 | 1 | 1 |

A real fetch with auto maintenance on, as users and the old test ran it:

| | 2.52 | 2.56 before | 2.56 after |
|---|---|---|---|
| base move (the fixture's 41 loose refs get packed on 2.56) | 24 | 107 here, 112 on CI (status 43/44, rev-list 37/41) | 30 (status 1, rev-list 1, for-each-ref 2, reconcile 5) |
| no-op fetch with 20 more loose branches (packed on 2.56) | 1 | not run; part (c) before, 47 (status 41), is the pack it triggers | 7 |

The store's own fetch adds the `git fetch` itself to each, and its events coalesce with
the `jobBase` it requests (`fetchPool`), as before.

## What a user sees

- On git 2.54+, a fetch, commit, merge or rebase that packs the refs no longer re-runs
  `git status` in every worktree of the project: one reconcile and one `for-each-ref`.
  Nothing shown changes, because nothing changed.
- A pruned remote-tracking ref (packed or loose) still refreshes the worktrees tracking
  it; `git branch -u` / `git push -u` still refresh the worktree whose upstream changed;
  both through the check, so one `for-each-ref` (and a 300 ms debounce, as before)
  ahead of the status.
- Given up: a packed-refs or config event no longer re-reads every worktree's dirty
  state as a side effect. That was never its purpose; missed edits fall to the poll
  (5 or 15 min) or the next event, as `project-lazy-base-counts.md` already says for
  base moves.
- Still not covered, as before: refs in a reftable repository (not routed; the poll).
  The user's or an agent's `git fetch` / commit in a terminal triggers the same pack and
  now costs the same 7 commands.
- A config rewrite that changes something other than upstreams and remotes (any
  `git config` in the repository) costs the reconcile and one `for-each-ref`, down from a
  status of every worktree.

## Tests

- `upstreams_test.go`: `TestUpstreamCheckRefreshesOnlyChangedUpstreams` (pack-refs: no
  status, one for-each-ref; a pruned packed origin/side and a pruned loose one: side's
  status only; `git branch -u`: that worktree only; a check with nothing changed agrees
  with what `git status` published for a remote, a gone and the base upstream),
  `TestUpstreamCheckBusySlot` (current and stale results of a status running during the
  check), `TestParseUpstreams`, `TestUpstreamMatches`.
- `watch_test.go`: `TestEventKeys` rows for packed-refs and config.
- `poll_cost_test.go`: parts (b) to (d) above.
- `rescan_test.go`: `TestConfigRewriteRefreshesUpstream` unchanged, passes through the
  check.

## Gotchas

- `%(upstream:track)` messages are translated (`_("gone")`, ref-filter.c); the runner
  sets `LC_ALL=C`, and an unparsable line refreshes every branch worktree.
- A test that measures a git operation's cost must decide whether git's auto
  maintenance is part of it: since 2.54 it packs refs after ordinary commands, so a
  fixture with many branches changes shape after a fetch or commit. Pass
  `-c maintenance.auto=false` where it is not, and measure the pack on its own.
