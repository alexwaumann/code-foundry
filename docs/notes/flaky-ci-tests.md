# Flaky CI tests (2026-11-11)

Three tests failed in one CI run (Actions run 42999906822, on a PR that changed only skill
text and a note) and passed on rerun. In all three the race was in the test, not in the
code under test, so this change touches only the three tests. Each fix makes the test wait
for, or control, the thing it was racing; no timeout was raised, no sleep added, and no
assertion loosened.

## HtmlPreview "posts the theme to the frame on load and on every theme change" (vitest)

CI: `expected "Mock" to be called 3 times, but got 4 times`.

Cause: `findByTestId` resolves as soon as the frame is in the DOM. The grant resolves
outside `act` (waitFor turns the act environment off while it polls), so React commits the
frame but runs that commit's passive effects in a later scheduler task. One of those
effects is HtmlFrame's `subscribeThemeSlots`, which calls back right away and posts the
theme once to the new frame. When the effects had not run by the time the test installed
its `postMessage` spy, they ran inside `fireEvent.load` (the `setVisibleKey` update there
flushes pending effects first). That mount post was the fourth call. Stack traces taken
from failing runs show the extra call coming from `subscribeThemeSlots` inside HtmlFrame's
effect, after `onLoad`.

The mount post is harmless in the app (it reaches the blank frame before its page loads),
so the component is unchanged.

Fix: rerender once after the frame appears and before spying. React runs a commit's
pending effects before it starts the next update, so the mount has settled when the spy
goes on. The exact count of 3 stays: once the mount has settled, the posts are exactly
load, the slot change and the preference change, and an extra post per change would be a
real regression.

Verified: 24 copies of the test, each run 100 times, in parallel on 12 cores (so 24
workers competing). Before: 35 of 2,400 failed. After: 0 of 7,200 with the default forks
pool and 0 of 2,400 with `--pool=threads`.

## TestSurfaceFloodThrottleLifts (internal/store/plugin)

CI: `surf: waiting for the flood issue; last: state=running err=""` after 26 s, in a
package run that took 307 s.

Cause: the host's clock in the test was `time.Now()` plus a skew that the test moves one
second after each act. The flood rule (`countLocked`) counts a window as a flooding second
only when it had more than 50 views and the next view comes less than 2 s after the window
started. Each act sends 100 views, one round trip each. Under `-race` on a busy machine one
act took more than a second of real time, so with the 1 s skew the next window began over
2 s after the last one started. The flooding-second count reset and the throttle never
started. The rule is right for a real clock; only the test's mix of real and skewed time
was wrong.

Fix: the clock is a fixed base plus the skew, so it moves only when the test moves it.
Nothing else in the test needs real time to pass on this clock: the other readers of
`Options.Now` are rate limiters, log and row timestamps, and kept-version ages.

Verified, `-race` binary, 12 processes at once: before, 48 of 48 runs failed at
`GOMAXPROCS=1`; after, 0 of 48 at `GOMAXPROCS=1` (single runs took up to 28 s, slower than
the CI failure) and 0 of 156 at `GOMAXPROCS=2`. A run takes 5 to 28 s under `-race`
(1,100 view round trips), so the count is lower than for the other two tests.

## TestPollCacheRestart (internal/store/gh)

CI: `cached branch = {... PullRequests:[] FetchedAt:0001-01-01 ...}` after 0.12 s.

Cause: the test waited for "a poll row with a time" as a sign that the poll's cache writes
were done, since a poll writes its poll row last. But there are two polls: `Track`'s
poll, and the one `BranchPullRequests` asks for once the branch is watched. The first one
can write a poll row before the branch is watched. The second sets the branch in memory
(which the test's first wait sees) before it writes the branch's cache row. So both waits
could pass while the branch row was still unwritten, and the second store, opened on the
same database, found no row for the branch. With logging added to failing runs, every
failure had a cached poll row older than the branch's fetch and no branch row.

Not a store bug: within a poll the cache trails memory by design, and a restart that lands
mid-poll recovers. A branch missing from the cache goes into the next poll soon
(`BranchPullRequests`, activity.go). The race needs the poll goroutine and the test to run
in parallel, so it never failed at `GOMAXPROCS=1`, which is also why it failed fast
(0.12 s) and not only on slow runners.

Fix: wait for the branch's cache row (one pull request, a fetch time) and a poll row at
least as new as it. Only the end of the poll that wrote that branch row, or a later poll,
writes such a poll row, so every row the restart reads is there.

Verified, `-race`: before, 9 of 300 and 11 of 400 failed in single runs; under load
(8 processes plus the plugin flood test running) 38 of 1,600 failed at `GOMAXPROCS=4` and
0 of 1,600 at `GOMAXPROCS=1`. After: 0 of 1,000 in a single run, and 0 of 1,600 at each of
`GOMAXPROCS=4` and `GOMAXPROCS=1` under the same load.

# Round 2 (2026-11-11)

Five more failures from CI runs in the week before, each of which passed on rerun. Two
were races in the product (gh, dictation) and one was a race in a test (thread). Two were
already fixed on main (project, the thread package's timeout), and one was a pull
request's own bug (the CLI tests). Stress runs used the `-race` test binary
(`go test -race -c`) with 24 processes at once on 12 cores, at the default GOMAXPROCS
and at 2 and 1.

## TestEventStateAfterFailedDetailReopen, TestCachedPullRequestAfterTheWatchEnded (internal/store/gh)

CI: `WARNING: DATA RACE`, a read in `WatchPullRequests` (pr_watch.go:74) against a write
in `setWatch` from the poll's `resolveWatchedHeads`.

Cause, in the store: `WatchPullRequests` makes `next` the store's `prWatches` under
`s.mu`, unlocks, and then logs `len(next)`. From the unlock on, `next` is the store's map,
and the poll goroutine writes it under `s.mu` (`setWatch` records a looked-up head). The
log line's read had no lock. It is harmless in effect (a debug count), but it is a data
race in the daemon, not only in the tests. It needs the poll to run in parallel with the
caller, so it never failed at `GOMAXPROCS=1`.

Fix: the count is read before the unlock.

Verified, both tests per run: before, 9 of 2,000 failed at `GOMAXPROCS=2` (each the same
race report), 0 of 2,000 at 1 and 0 of 400 at the default. After: 0 of 2,000 at each of
the default, 2 and 1.

## TestMemoryRefreshOnResume (internal/store/thread)

CI, two ways: `changed, started on send: the item's memory note = ""` (and the same for
`cleared`), and `timed out waiting for the next message of that process: the hash` with
the thread busy.

Two races, both in the test.

- The note. A message that starts a stopped thread is written as an item before the
  handshake, and gets its memory note only after it went to Claude
  (`proj.w.change` in sendMessage, after `conn.Send`). The test waited for the fake to
  receive the text, then read the item at once, so it could see the item before the
  note was written.
- The hash. The fake replays the next turn of its capture for every message, and
  text-table has one turn (the part after its result is only a `command_lifecycle`
  line). "three" is the second message of one process, so its turn never ends. The test
  passed only because `turnOver` read the status of the previous turn: the status is
  published after a 10 ms debounce, and a test that polled within it went on. When the
  test goroutine was late (a busy runner), the thread was busy for good. The restart in
  the next case then interrupted the turn that never ended (the fake's stdin log shows
  the `interrupt`).

Fix: the fake replays text-table twice in one file, so a process answers two messages.
Each case waits for the turn that read its message to be over
(`HandledThrough >= the item's ordinal`, as `TestHandledThroughPublished` does, beside
`turnOver` and the hash) before it reads the item's note. sendMessage writes the note
before it records the hash, so a hash that changed means the note is there; where the
hash does not change, the note is never written. The fork's wait at the end does the
same.

Verified: before, 2 of 240 failed (the note) at the default and 6 of 240 (the hash) at
`GOMAXPROCS=1`, 0 of 240 at 2. After: 0 of 480 at each of the default, 2 and 1.

The package's 10 minute timeout on 2026-11-05 (run 42106823986) was the
`TestMoveHoldsTheIdleStop` deadlock fixed by 5cd5baa23 that day: the run's branch did not
have that commit, and the dump shows the test asleep holding `m.mu` at the old line 730
while the run loop waits for `m.mu` in `startNaming`. On main it held: 0 of 240 at each of
the default, 2 and 1.

## TestCompareRunsNoSubmoduleFsmonitor (internal/store/project)

CI: `the submodule's core.fsmonitor ran: ran ran`.

Already fixed on main by 9d0083a78, which merged after both failing runs. The old canary
logged any git run in the submodule, so the store's own background `git status` could trip
it; the script now answers only to `GIT_NO_LAZY_FETCH`, which only a guarded comparison
command sets. Verified: the test as it was before that commit failed 66 of 900 with the
CI message (10/300 at the default, 29/300 at 2, 27/300 at 1); on main, 0 of 900.

## The CLI e2e tests at 60 s (cmd/code-foundry)

CI (run 42953317317, on a pull request's branch): `TestCLICapabilities`,
`TestCLIAgainstDaemon`, `TestCLINotifyReachesWatcher`, `TestCLIMemory`, `TestCLISettings`
and `TestCLIConfirm`, each `daemon did not become ready` after 60 s.

The branch's own bug, nothing on main: each also logs `daemon.Run: db: migrations
0059_plugin_dev_watch.sql and 0059_thread_turn_started.sql share version 59`, and every
other test that opens a database failed in the same run (internal/api, internal/client,
internal/command) with the same error. The branch had added a migration with the number
main had taken meanwhile, and it was renumbered to 0060 before it merged. Nothing
changed for these.

## TestDownloadSources (internal/store/dictation)

CI: the package hit the 10 minute timeout on main (run 41919048925). The dump: the test's
cleanup in `Store.Close`, waiting in `wg.Wait`, and one `Store.watch` goroutine ranging
over an engine's events that never ended.

Cause, in the store: `Close` detached the engine under `s.mu`, let go of it, and only then
cancelled `s.ctx`. A `reconcile` in `Launch` (which runs without `s.mu`) that got its
engine back in that gap took `s.mu`, saw the context still live, attached the engine and
started its `watch`. Nobody closed that engine, so `wg.Wait` waited forever. In the
daemon it would hang shutdown the same way when dictation was being turned on as it
stopped. TestDownloadSources hits it because a download that lands turns dictation on
(`Options.Enable`, whose test double calls `ConfigChanged` in a goroutine), so the store
starts an engine just as the case's cleanup closes it.

Fix: `Close` cancels `s.ctx` before it takes `s.mu`. reconcile checks `s.ctx` under
`s.mu` after `Launch`, so either it sees the cancel and closes the engine itself, or it
attached the engine before Close's lock and the detach takes it.

Verified. With one run per process and 8 processes at once: before, 2 of 3,000 hung
(both in `Close` with a `watch` left, at the default GOMAXPROCS; 0 of 1,000 at each of 2
and 1); after, 0 of 3,000. With more runs per process the hang is easier to hit: before,
61 of 1,200 processes hung (50 runs each with 24 processes at once, and 10 runs each with
12 at once); after, 0 of 600 processes (10 runs each with 12 at once) hung. Those faster
runs also failed in both builds with `connect: can't assign requested address`: thousands
of loopback connections a second used up the ephemeral ports. That comes from the stress
rate, not the test, and it was gone at one run per process (at most about 2,300
connections in TIME_WAIT).

The flaky tests in internal/store/plugin that CI hit from 2026-11-05 to 2026-11-11 are in
`docs/notes/flaky-plugin-tests.md`.

# Round 3: the shell branch (2026-11-13)

Seventeen tests from the shell build, in `docs/notes/shell-24b-flakes.md` with their before and
after rates. What they add to the rounds above:

- **A real time window in a test is a race with the machine.** The wake batch tests settled three
  children inside a 100 ms window; a busy machine took longer between two settles. Give the code
  under test a clock the test moves (`Options.batchClock` beside `Options.Now`), as round 1 did for
  the plugin flood.
- **Wait for what the next step reads, not for something near it.** Busy is set before Claude's
  handshake, connected after; a row's step runs after the projects fake starts; a fake's stdin log
  trails the store's write; a snapshot runs ahead of its bus event. Each test waited for the near
  thing and read the far one.
- **A fake that replays a capture can replay too much.** A resumed fake process starts the capture
  over and re-asked a withdrawn request under the same id. Give the fake the next process's
  answer (`CF_FAKE_CLAUDE_RESUME_FIXTURE`) rather than racing the replay.
- **"Which one failed" is not "the first failed".** Steps that run side by side can fail together;
  check the one the case is about.
- **Speed limits become counts.** A wall-clock bound in a test (250 ms, 5 s) measures the
  machine. Count the work that would blow up if the code regressed: allocations per node,
  characters read per character.
- **A vitest timeout does not stop the body.** Vitest fails the test and runs the next, while the
  old body keeps going against module-level fakes and with `act` scopes open, and the next tests
  fail to find their elements. One slow test under load failed dozens after it. Make the next
  test wait for the old body (`src/test/isolate.ts`), and make the slow one cheap; a tight
  `--testTimeout` shows whether a file cascades.
- **Some flakes are the app's.** Two of these were: a new space's composer took the keyboard
  from its name field when its focus frame came second, and one fs event delivery could be split
  into two files events. Fix those in the app and say so.

