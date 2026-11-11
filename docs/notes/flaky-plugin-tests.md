# Flaky tests in internal/store/plugin (2026-11-11)

Seven tests in this package failed on CI (macOS runner, `go test -race`, 140 to 180 s for
the package) and passed on rerun. They come down to three races. One was in the code under
test and was already fixed on main. One is in the store's log and is fixed here in the
product code. The third was in a test. The model is `docs/notes/flaky-ci-tests.md` (PR
#649): each fix makes the test wait for, or control, what it raced. No timeout was raised,
no sleep added, no assertion loosened.

Stress runs: the `-race` test binary built once (`go test -race -c`), the single test run
by 24 processes at once on 12 cores, at the default GOMAXPROCS and at 1 and 2. "Before" for
the not-open tests is aeacb03d3 (main just before 17057ca47). For the other tests it is
main at 3ea4205a3.

## Acts refused as "not open": TestOversizeActStoresNoSecret, TestSurfaceSelectAndNodeTabActs, TestSurfaceActs, TestSurfaceNotRespondingAndPluginDown

CI: `failed precondition: surf/panel/thread:s-1 is not open (watch it first)` on the
first act after the first view.

Cause, in the product: a plugin shows its first view before it answers `surface/open`.
The store refused an act that came between the two. The SDK would have refused it too.
The tests act as soon as they see the first view, so they hit that window whenever the
open's answer was slow. A user clicking the first view quickly hits the same window.

Fix: already on main as 17057ca47 (PR #631, merged after all of these CI runs). An act
on an instance whose open is in flight now waits for the open's answer. It goes on if the
open succeeds and is refused if it fails. TestSurfaceActWhileOpening covers this. Every
CI failure listed above came before that merge.

Stress, before → after (failures/runs, default, 1 and 2 GOMAXPROCS each 120):

| test | before | after |
| --- | --- | --- |
| TestSurfaceSelectAndNodeTabActs | 6/360 | 0/360 |
| TestSurfaceActs | 2/360 | 0/360 |
| TestSurfaceNotRespondingAndPluginDown | 5/360 | 0/360 |
| TestOversizeActStoresNoSecret | 4/360 | 0/360 |

Every "before" failure was the "is not open" refusal.

Same pattern elsewhere: `waitOpen` (layout_acts_test.go) and a loop in TestListRowActs
retried an act until it stopped failing with "is not open". These retries were the
earlier workaround for this race. They are gone now, because an act waits for the open.
Their callers are TestLayoutActEdges, TestActsOnRecentVersions, TestActTimeoutAndStop,
TestTableSortActs, TestSurfaceFloodThrottleLifts and TestListRowActs. Each now acts once
after the first view. The counts in TestLayoutActEdges and TestActsOnRecentVersions are
one lower, since waitOpen's own inc no longer runs.

## TestSurfaceLifecycle

CI: `reopen state {Phase:live ...}` then `cached view: timed out`.

Cause, in the test: after the grace closes the instance, a new watcher should first get
the cached view in the opening state, then the plugin's fresh view. WatchSurface starts
the reopen before it returns. The watcher's first pull runs in its own goroutine
(`serve`). On a busy machine, the plugin's fresh view and its answer to the open could
both land before that first pull. The watcher then got only the live state and the fresh
view, and never the cached one. The store behaves correctly here: a watcher always gets
the newest view.

Fix: the test controls when the reopen's view comes. The surface test plugin has two
commands. `hold-open` makes the panel factory wait, and `release-open` lets it go on. The
test holds the open, watches, sees the opening state and the cached view, releases, then
sees the fresh view.

Stress: before 3/720 (1/120 at the default GOMAXPROCS, 0/120 at 1 and at 2, then 2/360
at the default). Every failure was the CI failure: a live state first, then no cached
view. After: 0/720 in the same runs.

## TestMisbehavingPlugins/flood

CI: `TempDir RemoveAll cleanup: unlinkat .../TestMisbehavingPluginsflood...: directory not
empty`. The `heap ... MB` line above it is a t.Logf, not the failure.

Cause, in the product: a plugin's log (`logBuffer`) wrote through `logfile.File`, which
opens its file again on the first write after Close. A plugin's connection keeps reading
after its run ends: the reader drains the line it was dispatching, and the stderr reader
drains what is left. While doing so it still reports protocol issues ("refused secret/list:
N requests in flight", "dropping notifications") into the log. When one of those lines
came after `Manager.Close` closed the logs, it recreated `logs/hello.log` and its
directory while t.TempDir's cleanup was removing them. The flood plugin makes this likely
because the reader is always mid-backlog. The same thing could recreate a removed plugin's
log file (`Reload`, which also closes the log).

Fix: a closed `logBuffer` stops writing its file. Later lines go to the in-memory tail
only. Both callers of `close` (Manager.Close and a plugin's removal) mean the log is done
for good. A re-added plugin gets a new buffer. TestLogBufferAfterClose covers it.

Stress: before 2/720 (1/120 at the default GOMAXPROCS, 0/120 at 1 and at 2, then 1/360
at the default). Both were "directory not empty". After: 0/720 "directory not empty"
in the same runs, and one other failure, below.

Not fixed: one "after" run at GOMAXPROCS=1 failed differently, with `disable took
10.13s`. That run took 26 s, against 4.4 s on CI. Disable's own deadlines add up to about
7 s with this test's options: a ping in flight (2 s), the shutdown call (1 s), stdin
close, SIGTERM, then SIGKILL (1 s each). The test's 10 s bound left about 3 s for 24
starved race binaries. That is a wall-clock bound under starvation and has not failed on
CI. Changing it would mean loosening the assertion, so it stays as it is.

## Same pattern: a real clock where kept versions are asserted

TestSurfaceFloodThrottleLifts (PR #649) failed because the host's clock counted real
time. Acting on an older version depends on real time in the same way: a version stays
kept for `keptFor` (3 s) after it is replaced. These three tests act on an older version
with the host on the real clock, so acts that are slow enough in real time would see it
pruned:

- TestActsOnRecentVersions: `time.Now()` plus a skew, as in #649. It is now a fixed base
  plus the skew.
- TestLayoutActEdges and TestSurfaceActs: the default real clock. They now take
  `stillClock`, a host clock that stands still.

None of these failed on CI, and none failed locally: 0 of 360 runs of the three
before and 0 of 360 after. The change
removes the dependence on real time, as #649 did. The other readers of `Options.Now` here
are rate limiters (a few views or log lines in these tests), log and row timestamps, and
kept-version ages.
