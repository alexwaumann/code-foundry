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
