# Timing-sensitive tests: project store and two e2e specs

Tests that failed in `make check` on a loaded machine (load 30 to 70) and passed alone.
Rates below are from the same harness before and after: the package's race test binary,
8 processes × `-count 10` of one test, 12 busy loops alongside (load 30 to 75).

## Causes

- **fseventsd numbers events out of write order under load.** A stream started "since now"
  still delivers writes made before it started (a fixture's `git init`, commit, push,
  `remote set-head`), up to seconds later, and with event ids *after* those of writes made
  later: a marker file written after Register was delivered first, then the fixture's
  `.git/index`, `HEAD`, `config.lock` and `README.md` (ids greater than the marker's). So
  no barrier or settle window can tell "everything before now has arrived"; the old fix for
  TestPollTiers (wait until status runs stop for 500 ms) still failed 17 in 80 here.
  Measured delivery lag at load 30: p50 0.2 s, p90 1.6 s, max 2.3 s.
- **TestTouch, TestPollTiers** counted status runs; the late events add runs (and once
  refreshed with the edit before Touch's window). They now set `Git.ignoreStream` (the
  watcher's batches are dropped; `onEvents` still works when called directly): only Touch,
  TouchNow and the poll run status. Before: 41/80 and 17/80 failed. After: 0/80 each.
- **TestNoSelfTriggeredRefreshLoop** counted status runs for a second after a 300 ms
  settle. It now checks the cause directly: three Refresh calls leave every file in the
  repository (`.git` but its object store) unchanged. Without `GIT_OPTIONAL_LOCKS=0` it
  fails on `.git/index`. Before: 27/80 failed. After: 0/80.
- **TestFilesEventLiveOnly** feeds `onEvents` itself; the stream's own late events for the
  test's `.gitignore` and `a.go` arrived after the worktree went live and showed up in the
  files events. It ignores the stream now. Before: 28/80. After: 0/80.
- **TestStreamFilesEvent** found a product bug: `bornSlack` (how long before its first
  event a file may have been born and still count as created) was 1 s, below the delivery
  lag under load, so a new file was reported `modified`. Now 10 s (a stale `ItemCreated`
  comes from files born 30 s and more before; a file born under 10 s before its worktree
  went live and then edited now reads `created`). `TestResolveFiles` gains a file born 3 s
  before its event (failed first). The test no longer sleeps `bornSlack`: it sets README.md's
  mtime into the past, which pulls its birth time back. Before: 29/80. After: 0/80.
- **thread.spec.ts "reading the answer when the turn ends"** found a product bug: when a
  turn ends with the user scrolled up, the anchor row's new start was read from
  `v.measurementsCache`, which TanStack Virtual refreshes only in `getMeasurements()`. Once
  the user has stopped scrolling (past the virtualizer's 150 ms scrolling window), the rows
  the turn's end shows are measured as they mount and TanStack compensates scrollTop, but
  the anchor then used the sizes from before (26 px estimates, 24 px real) and moved the
  answer 8 px. It passed only when the finish came within 150 ms of the wheel, so a busy
  machine made it fail. Timeline reads `v.getMeasurements()` everywhere; the spec waits
  300 ms (a reader who stopped scrolling) before the turn ends, which fails 4/4 on the old
  code. Before: 6/12 under load. After: 24/24 under load.

## Not fixed

- **TestStreamSeesGitInit**: not reproduced (0 in 160 targeted runs and 8 full package runs
  under load). Register syncs the stream before it returns, so `git init` is after the
  stream started; a late delivery only delays the reconcile. The likely failure is its 10 s
  wait when fseventsd falls further behind (at load 128 TestStreamFilesEvent saw no event for
  20 s).
- **terminal-find.spec.ts "Ctrl-C reaches the prompt within seconds of a flood"**: not a
  slow step. Under load (20 to 55) with the find bar open, the ^C keystroke reached the mock
  15 to 30 s after the press: the page's main thread is blocked (a `page.evaluate` before it
  also waited 15 s). With the bar closed, same load: ^C at the mock in 2 s, prompt 0.3 s
  later. So find still costs the main thread under a flood when the machine is busy; a likely
  path is the search addon putting all 20,000 highlights back after any 200 ms output gap
  (which a starved mock and browser produce mid-flood) and the next 256 KiB chunk trimming
  lines past them (docs/notes/terminal-find-flood.md). A fix belongs in src/terminal/find.ts
  and was not attempted here; raising the 40 s limit would only hide it.

## Gotchas

- An FSEvents barrier (write a file, wait for its event) does not cover earlier writes:
  neither delivery order nor event ids follow write order when fseventsd is behind.
- `Git.ignoreStream` is a test seam: the store never sets it.
