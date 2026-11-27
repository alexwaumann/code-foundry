# The project-list lease lapses while the window is hidden

Status: done on `fix/gui-projects-lease-while-hidden`. Follows PR #901
(`perf-gh-gate-poll-projects.md`).

## The problem

`watchProjects` (`gui/frontend/src/stores/gh.ts`) is held while the Pull Requests page, or
a page bridge `gh` subscription, is mounted. Its `setInterval` re-read the dashboard every
`PROJECTS_WATCH_KEEPALIVE_MS` (5 min) with `watch_projects: true`, which renews the daemon's
10-minute `PollProjects` lease. Nothing checked whether the window was visible, so an app
left hidden on that page kept the project poll that the lease was meant to gate running
for as long as it was open: one extra GraphQL search per background-tier poll (every
5 min), indefinitely.

There was a second way to renew the lease. The fetcher sent `watch_projects: true` on
every dashboard read while a watcher was held, including reads caused by a
`DashboardUpdated` event. `PollProjects` publishes that event when the project lists
change, so while hidden on a busy set of repositories the lease could renew itself from
its own poll, even without the keepalive.

## What changed

- **One signal, the existing one.** `isPageVisible` / `onBecameVisible` from
  `src/api/stream.ts` (`document.visibilityState`). The same signal drives the daemon's
  poll tiers (`events.ts` reports it, `gh-poll-tiers.md`) and the file-stamp poll
  (`fileStamps.ts`). In the Wails WKWebView it turns hidden on hide (Cmd-H), minimise and
  full occlusion (gotchas in `gh-poll-tiers.md` and `plugin-surface-shot-host.md`), so a
  window fully covered by others also lets the lease lapse, matching the daemon's
  background tier. No host event is needed.
- **The fetcher** sends `watch_projects: true` only while a watcher is held *and* the page
  is visible (`renewsProjectsLease`). A read while hidden is a plain one.
- **The keepalive tick** renews only while visible. A tick that falls while hidden sets
  `projectsRenewalMissed` and sends nothing.
- **On becoming visible** with a watcher held and a renewal missed, it renews once (one
  invalidate) and restarts the interval, so the next renewal is a full period later. A
  hide with no tick in it sends nothing on return (the lease is still live, and the
  daemon's presence snap-back polls the project lists within about half a second). Any
  number of quick flips sends at most one read per missed tick, because the flag is
  cleared by the first return and the restarted interval cannot miss again for 5 minutes.
- **First watch while hidden** sends nothing and counts as a missed renewal, so the first
  return renews.
- **The last release** clears the timer, the visibility listener and the flag. All state
  stays module-level, outside React, as before. No store field, no effect.

## The page bridge

The bridge's `gh` source shares the same counter, so it gets the same rule with no code of
its own. That is intended: a bridged page renders in the same WKWebView, so it is hidden
whenever the window is. A page is a view, not a background job. On return it gets fresh
lists the same way the Pull Requests page does.

## What the user gives up

- Hidden for less than 10 minutes since the last renewal: nothing. The lease is still live
  on return, and the daemon kept polling the lists in its background tier.
- Hidden longer: the lists stop updating once the lease lapses. On return the renewal
  reaches `WatchProjects`, which sees lists older than the poll interval and queues an
  off-band `PollProjects` at once. The page shows the old lists, with its "updated Ns ago"
  line saying how old they are, for about one GraphQL round trip (a second or two), then
  the fresh ones.

## Daemon side (checked, not changed)

`GetDashboard` with `watch_projects: true` (`internal/api/gh_activity.go`) is the only
caller of `Store.WatchProjects`. `applyPoll` and `runPollProjectsNow` run `pollProjects`
only while `projectsWatched(now)`. `TestPollProjectsGatingAndLease` step 4 already shows
that no renewal for 10 minutes stops `PollProjects` and keeps the cached lists.

## Found, not changed

- **Likely one duplicate project search on returning after a lapse.** The return's renewal
  queues an off-band `PollProjects` (the lists are stale). About 100 ms later the GUI
  reports the window visible, and the presence snap-back runs a full poll within 0.5 s.
  That poll also runs `pollProjects`, because the lease is live again and `pollProjects`
  has no freshness check. This is inferred from the code, not measured. It costs at most
  one extra search per return after a long hide, against twelve an hour before. A daemon
  fix would be to skip `pollProjects` in `applyPoll` when `Projects.FetchedAt` is newer than
  the poll interval.

## Tests

`src/stores/ghBatch.test.ts`, "watchProjects keepalive lease" (vitest, fake timers, jsdom
`visibilityState` stubbed as in `watchVisibility.test.ts`). The cases: hidden sends no
renewal over three periods, and the return renews once and restarts the period; a dashboard
event read while hidden sends `watch_projects: false`; a 1-minute hide sends nothing extra
and keeps the schedule; ten quick flips after a missed tick send one read; a watch begun
while hidden renews on return; release while hidden leaves no timers and a later watch
starts clean; two watchers share one keepalive until the last lets go. The suite's watches
are released in `afterEach`, so one failing case cannot leak a watcher into the next.
Against the old `gh.ts`, the four hidden cases fail.

End to end with `make drive` (mock daemon and Vite, WebKit, Playwright's fake clock), on the
real Pull Requests page:

- one `{"watchProjects":true}` read at 5 min while visible;
- none in 15 min hidden;
- exactly one on return;
- none 4 min later, then one at 5 min;
- a mock dashboard change while hidden re-read with `{}`.

The mock has no lease, so the daemon half rests on the Go test above.

## Gotchas

- Playwright's `page.clock` must be installed before the app's timers start, so install
  it, then reload.
- To read GetDashboard bodies, wrap `window.fetch` after load. `&json=1` makes them
  readable.
