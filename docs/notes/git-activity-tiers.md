# Git activity tiers and thread-driven refresh

Status: done on `cf/git-activity-tiers` (PR 1 of 3), rebased onto PR 2 (#169, the
FSEvents watcher, `fsevents-watcher.md`), which merged first: the live poll is now 2 min,
not the 30 s this branch first shipped with (see "Rebased onto FSEvents" below).
`make check` is green. Run end to end on 2026-10-17, before the rebase, with two scratch daemons (`CODE_FOUNDRY_HOME=/tmp/cf-tiers/home` and
`home2`, `daemon --dev`), two scratch projects under `~/cf-scratch-tiers` (`live`,
`idle`, each with a bare origin in `/tmp`), and Haiku 5.5 threads at medium effort.

## What changed

The project store polled every project every 2 min and fetched every project every 2
min, whether or not anyone was working in it. Nothing told it a thread had edited files:
before PR 2 an agent's edits below a worktree's top level (which the non-recursive
kqueue watcher could not see) showed up only at the next poll. The FSEvents stream now
sees them within its 1 s tree window; the thread-driven refresh below is a second path
that does not depend on the stream (a stream that failed to start, a rescan).

Now each project is **live** or **idle**:

* **Live worktree**: at least one thread in it is not archived and not snoozed (or its
  snooze has passed), or `GetWorktreeDetail` was called for it within `DetailWatch`
  (10 min, the worktree panel renews it every 5). A project is live when any of its
  worktrees is.
* **Idle**: everything else.

| Loop | Live | Idle | Option (live / idle) |
|---|---|---|---|
| Backstop poll (`jobBase`, then status of every worktree) | 2 min | 10 min | `PollInterval` / `IdlePollInterval` |
| `git fetch --prune` | 2 min (`projects.fetch_interval_seconds`) | 15 min | `FetchInterval` / `IdleFetchInterval` |

The idle interval is never shorter than the live one: a fetch interval set above 15 min
applies to idle projects as well. The settings description says so.

When a project turns live, both loops are woken. A fetch older than the live fetch
interval (2 min) runs now, and so does a poll older than the live poll interval (2 min). A project that was idle for a while
is therefore fetched and polled the moment a thread starts or comes back (unarchive,
snooze ends) in it.

Threads also refresh their worktree directly:

| Thread item | Request |
|---|---|
| A tool result (done or error) of `Edit`, `Write`, `MultiEdit`, `NotebookEdit` or `Bash` (subagents' included) | status of the thread's worktree, **3 s trailing debounce** per worktree (`Touch`) |
| `turn_end` | status of the thread's worktree **at once** (`TouchNow`), cancelling a pending `Touch` |

The status job then schedules the detail recompute as before when the worktree's
detail is watched, so the worktree panel stays current.

## Design

**Project store (`internal/store/project/activity.go`).** Three methods on `Store` (and
`*Git`, and `projecttest.Fake`, which records them):

* `SetLiveWorktrees(paths []string)` replaces the whole set. The set form was chosen
  over per-path `SetLive(path, bool)` because it is idempotent: the caller recomputes it
  from the thread snapshot, so a dropped bus event or a missed transition cannot leave a
  worktree live forever. Paths are symlink-resolved (`realDir`) and kept even when no
  project has them yet. They match once a reconcile adds the worktree. Gaining a path
  wakes both loops.
* `Touch(path)` goes through its own `debouncer` (`Options.TouchDebounce`, default 3 s),
  so fs events keep their windows (300 ms for git's directories, 1 s for a worktree's
  tree). The store has three debouncers side by side; each is a per-key trailing timer
  feeding the same scheduler, which merges a request for a job already queued. Same semantics: the first touch arms the timer,
  later ones are absorbed, one status job when it fires.
* `TouchNow(path)` requests the status job and cancels an armed `Touch` for that
  worktree (`debouncer.cancel`), so a turn that ends right after an edit costs one `git
  status`, not two.

Both loops are now `tierLoop` over a `tierSched` (per-project last run). Each round runs
every due project. The loop then sleeps until the next project is due, at most the live
interval, or until a nudge. `due` is exact (`now >= last + every(tier)`), so no slack is
needed. Liveness is read at each round: `projectLive` checks the live set against the
project's worktree slots, and `detailState.requested` for an unexpired detail watch.
A watch lapsing needs no event, since the next round simply sees the project as idle.
`WorktreeDetail` nudges when it starts a new watch.

* **Fetch** keeps `firstFetchDelay`: the first round is at 10 s (or the live interval if
  shorter), and every project is due in it (zero seed), live or idle, as before. After
  that each project follows its tier.
* **Poll** seeds every project's last run with the store's start time: `Start`'s
  reconcile has just refreshed everything, so the first poll is one interval later
  (2 min for a live project, 10 min for an idle one).
* A visit that skips the fetch (no origin, project in error) still counts as a run, so
  the loop never spins on such a project.

**Daemon glue (`internal/daemon/projectactivity.go`).** The project store does not import
the thread store; `startProjectActivity` connects them, like `startWakeRuns`:

* `bus.Subscribe[thread.Event]` (Updated, Removed). On every event, and once a minute
  (in case the deciding event was dropped), it recomputes `liveWorktrees(snapshot, now)`:
  sorted distinct `WorktreePath`s of threads with a project, not archived, and not
  snoozed into the future. It calls `SetLiveWorktrees` only when the list changed. Thread
  creation, archive/unarchive, snooze/wake, removal and a RunIn move all publish
  `Updated`/`Removed`, so no event kind is special-cased.
* `bus.Subscribe[thread.ThreadEvent]` (the item events; buffer 2048, because every
  text delta comes through too). `touchFor` picks tool results and turn ends from
  `ItemAppended`/`ItemUpdated`. The thread's worktree comes from the thread snapshot.
  Threads without a project (cwd `$HOME`) are skipped. No new hook or event was needed:
  tool results were already on the bus.

## End to end

Recorded before the rebase onto PR 2, so the live poll in these logs is 30 s and the
watcher is still kqueue (it could not see the nested edits). The tier mechanics are
unchanged by the rebase; only `DefaultPollInterval` moved.

The branch binary, `daemon --dev`, both scratch projects registered with `project add`.

**Thread-driven refresh** (daemon 2, thread `tiers e2e 2` in `live`). Turn 1 edited
`src/deep/nested.go` (already modified, so its status did not change). Turn 2: Write
`src/deep/added.go`, `sleep 6` in Bash, `rm src/deep/added.go`, reply. Item times
(UTC, from `thread read --json`) and the daemon log (local, UTC-5):

```
10 toolCall Write  created 21:46:03.211  result 21:46:03.458
11 toolCall Bash   created 21:46:04.744  result 21:46:11.424   (sleep 6)
12 toolCall Bash   created 21:46:12.725  result 21:46:13.269   (rm)
14 turnEnd                21:46:14.433

16:46:06.460 msg="worktree touched" path=…/cf-scratch-tiers/live debounced=true      # Write + 3.0 s
16:46:06.468 msg="worktree status changed" … modified=1 untracked=1
16:46:14.424 msg="worktree touched" path=…/cf-scratch-tiers/live debounced=true      # sleep result + 3.0 s (rm absorbed)
16:46:14.433 msg="worktree touched" path=…/cf-scratch-tiers/live debounced=false     # turn end, same ms
16:46:14.440 msg="worktree status changed" … modified=1 untracked=0
```

The nested file's creation (invisible to the watcher) reached the snapshot 3.0 s after
the Write result, with no poll in between (the project's polls were at :54 and :24).
Its removal reached it 7 ms after the turn end. Turn 1's Edit result at 21:45:41.452
gave `worktree touched debounced=true` at 16:45:44.454 (3.0 s).

**Tiers** (daemon 1, started 16:43:02; thread `tiers e2e` created in `live` at 16:43:30
and left there, nothing in `idle`):

```
16:43:12.755 msg=fetch project=55105d1f112c tier=idle      # first round at 10 s: both
16:43:12.785 msg=fetch project=c6794acf4db4 tier=idle
16:43:30.253 msg="live worktrees" count=1                   # thread created in live
16:43:32.758 msg=poll project=55105d1f112c tier=live        # every 30 s from here on
16:45:12.757 msg=fetch project=55105d1f112c tier=live       # every 2 min from here on
…
16:53:02.757 msg=poll project=c6794acf4db4 tier=idle        # idle: first poll 10 min after start
16:58:12.788 msg=fetch project=c6794acf4db4 tier=idle       # idle: 15 min after its last fetch
```

From 16:43 to 16:59 the live project was polled 32 times and fetched 9 times (8 on the
live tier). The idle
project was polled once and fetched twice (start and +15 min).

**Live → idle → live** (daemon 2): archiving the only thread made `live` idle, and
unarchiving it 13 minutes later fetched and polled it at once:

```
16:45:34.916 msg=fetch project=55105d1f112c tier=idle       # first round
16:45:54.917 msg=poll project=55105d1f112c tier=live
16:46:22.199 msg="live worktrees" count=0                   # thread archived
16:55:54.918 msg=poll project=55105d1f112c tier=idle        # 10 min after its last poll
16:59:51.459 msg="live worktrees" count=1                   # thread unarchived
16:59:51.459 msg=fetch project=55105d1f112c tier=live       # last fetch 14 min old: now
16:59:51.459 msg=poll project=55105d1f112c tier=live
```

Neither log had a warning or error.

## Tests

* `activity_test.go`: `TestTiers` (interval resolution), `TestTierSchedDue` (tier
  selection, including "turned live with a 5 min old fetch: fetch now" and "90 s old:
  wait"), `TestTierSchedWait`, `TestTierSchedForget`, `TestProjectLive` (symlinked live
  path, nudges only on gain, detail watch and its expiry), `TestPollTiers` and
  `TestFetchTiers` (real store, counting runner: no polls/fetches at the live interval
  while idle, they resume on `SetLiveWorktrees` or a detail request), `TestTouch` (a
  burst of touches through a symlink is one status run after the window, catching a
  nested edit; `TouchNow` at once; `Touch` then `TouchNow` is one run).
* `sched_test.go`: `TestDebouncerCancel`.
* `internal/daemon/projectactivity_test.go`: `TestLiveWorktrees`, `TestTouchFor` (tables)
  and `TestProjectActivity` (bus to recorder: live set changes only, archive, touches;
  threads without a project and unknown threads ignored).
* The test harness sets the idle intervals to the live ones unless a test sets them, so
  the existing `PollInterval`/`FetchInterval` tests keep their meaning.

## Gotchas

* A thread's tool result can coincide with a live poll. In the first e2e run the live
  poll (30 s then) caught the edit 200 ms after the result, before the touch fired. The
  `worktree status changed` debug line (new) shows which job saw a change.
* The debouncer's timer callback used to delete its key unconditionally. With `cancel`,
  a cancelled-then-rearmed key could lose its new timer's entry, so the callback now
  deletes (and fires) only when the entry is still its own timer.
* `liveWorktrees` returns a non-nil empty slice, and the glue always makes its first
  `SetLiveWorktrees` call, so "no live worktrees" is sent explicitly at start.
* A `cf thread new` against a home with no daemon auto-starts a non-dev daemon, which
  logs no debug lines. Start `daemon --dev` first and wait for it.
* The worktree-isolation hook refuses command lines naming `git` twice (the branch name
  counts) and heredocs; the e2e ran from scripts in `/tmp/cf-tiers-scripts`.

## Rebased onto FSEvents

PR 2 (#169) merged before this one, so this branch was rebased onto it (main was not merged in).

* `store.go` conflicted around the debouncers, `Start`/`Close`, the loops and the
  option comments. Resolved by keeping both: `deb` (300 ms) and `treeDeb` (1 s) from
  PR 2, `touch` (3 s) from here, the FSEvents `run`/`dispatch` goroutines from PR 2, and
  the two `tierLoop`s from here in place of PR 2's `fetchLoop`/`pollLoop`. PR 2's
  kqueue `watchLoop`/`keysFor` removal stands.
* `DefaultPollInterval` stays at PR 2's 2 min, which is now the live tier. The idle
  tiers (poll 10 min, fetch 15 min) and the live fetch (2 min) are unchanged.
* `TestTouch` writes a nested file and counts status runs. The FSEvents stream now
  sees that write too, so the test sets `TreeDebounce` to an hour: only `Touch` and
  `TouchNow` refresh in it.
* `docs/ARCHITECTURE.md`'s project store paragraph merges both descriptions.

## Left out

* The idle intervals are constants (options only), not settings.
