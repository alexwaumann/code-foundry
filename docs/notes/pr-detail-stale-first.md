# Pull request detail: any cached copy answers at once

Status: PR 1 of 3 on "PRs load really slow", reported by a user with no timings. `make check`
is green. Run end to end on 2026-11-03 with a scratch `daemon --dev` on real GitHub (read only;
no merge or other write was sent), the CLI, and the mock GUI in WebKit. Next: seeding the header
from the dashboard row and hover prefetch; user jobs ahead of the poll.

## What changed

* **Stale first.** `FullPullRequest` answers from any cached copy. A copy that is not current
  (stale, aged, or a row just read from SQLite) comes back with `Refreshing` set and one fetch
  queued behind it. What still waits for GitHub: nothing cached, `refresh`, the read right after
  this store's own write, and decisions (`currentFull`).
* **`PullRequestDetail.refreshing`** (field 29, never stored). The GUI needs it: see Decisions.
* **Events.** A background fetch always ends in `PullRequestDetailUpdated`, changed or not,
  because a client was told `refreshing` and needs to hear it ended. The event's new
  `Unchanged` says only the copy moved (`fetched_at`, `refreshing`, `fetch_failed`), and the
  plugins' checks fact skips those. A stale entry's fetch now announces a change too; before,
  the read that fetched was the one waiting for it.
* **Failures.** A failed fetch is kept on the entry (`failure`, `failedAt`), said once by event,
  and every later read serves the copy with `FetchFailed` and `LastError`. Reads do not try
  again for `fullRetryAfter` (30 s), or the event's own re-read would fetch at once. A pause
  queues nothing and serves the copy with the pause's error, as before. A deleted pull request
  is the same case: the copy plus the banner, not the not-found page.
* **Queue.** `job.background` jobs have nobody waiting and run behind every job somebody waits
  for; joining one promotes it. Coalescing is the existing queue key plus the job's own check:
  a job that finds a fetch ended since it was submitted takes that outcome and sends nothing.
  The poll is still one job, so the next PR can put waiting jobs ahead of it here.
* **`confirmWindow` follows `pollCadence`**: `nextInterval` for the current presence, not the
  configured 60 s. The age limit stays the configured interval, and `confirmedMaxAge` (10 min)
  still caps it, so no GUI (15 min) is bounded by that cap and not by its 22.5 min window.
* **Log.** One Info line per fetch: `gh pull request detail fetch pr= query= queue_wait= fetch=
  background=`, plus `err=`. `queue_wait` includes MinGap and any running poll.
* **GUI.** A landing fetch replaces the resource's data, so nothing remounts: tab, scroll and
  composer stay. `Updating…` shows in the inner tab bar only after 2 s of `refreshing`, so a
  normal open shows nothing. A failed background fetch is the existing "Showing the copy from"
  banner.
* **PRs page before the first poll**: a skeleton in the page's shape instead of "No open pull
  requests" (`dashboardLoad`). It fit in this PR.

## Decisions

* **The read after a write waits, which departs from "only no cache blocks".** `submitReview`,
  `changePullRequest` and the reviewer flow invalidate and `await settled(...)` so a button comes
  back showing the new state. Served stale, the composer would close on the old state and flip a
  second later. After a write the copy is known wrong, not merely old, so `invalidateFull` sets
  `written` and reads wait, as they always did. A failed fetch clears it, so reads never queue up
  behind a network that is down.
* **`pr.merge`'s confirmation asks GitHub when there is no `--head-sha`.** It reads through the
  same RPC and is the user's look at what merges, while the store merges the head it fetches. A
  stale copy there would name one head and merge another. With `--head-sha` (the GUI) the store
  refuses any other head, so the cached copy will do and the dialog does not wait. This is a
  second caller found beyond the three listed; it costs one request per CLI merge.
* **`detailFresh` is false while `refreshing`.** Rows in SQLite can predate fields:
  `autoMergeAllowed` reads false on a row from before it, which would flash "Auto-merge is off
  for this repository" on every first open after an update. This is why the flag exists.
* **`pr.explain`, `pr.ask` and the tasks that do not push stay on the stale-first read.** They
  start read-only threads and were pinned "not refreshed", so their prompt can carry a stale copy
  (title, branch). The tasks that push already refresh. If that turns out to matter, passing
  refresh in `readPR` is one line.
* **`currentFull` keeps its old fallback**: a failed fetch answers with the cached copy. GitHub
  still guards the mutation with `expectedHeadOid`, and a pause fails at the mutation's submit.
* **Info level for the log line.** Fetches run on change or age, far under a poll a minute at
  steady state; the worst case is about one a minute per shown pull request the poll does not
  cover. Measure before keeping it if it proves noisy.
* **Two signals end the PRs skeleton.** A first poll that finds nothing publishes no
  `dashboard_updated` (the comparison ignores `FetchedAt`), so `fetchedAtMs` alone would leave a
  viewer with no pull requests on the skeleton forever: the `polled` event ends it too. While a
  re-read is in flight it holds on, so the empty text does not flash before the rows.
  Unauthenticated and dashboards off keep their banners; a failing first poll says why.

## Measured (2026-11-03, this machine, one account, alexwaumann/code-foundry #504-#509)

Old and new binaries, scratch homes, `curl` over the unix socket, reads one after another. All
six are merged pull requests of 7-15 KB, so a busy open pull request costs more on the old path.

| GetPullRequestDetail | Before | After |
|---|---|---|
| Warm SQLite, right after a restart | 0.92-1.64 s | 1.1-2.5 ms |
| Nothing cached, first read after start | 8.23 s | 6.76 s |
| Nothing cached, later reads | 1.57-1.69 s | 1.45-1.73 s |
| Re-read once settled | 0.6-0.8 ms | 0.7-1.0 ms |

From the new log line, nothing cached: the first read spent `queue_wait=6.316s` behind the
startup poll and `fetch=444ms` at GitHub. Later reads were 0.98 s of MinGap plus 0.47-0.75 s of
fetch. So about two thirds of a back-to-back read is MinGap, and the worst case is the running
poll, which is what the next PR takes on. Six background refreshes drained at about 1.6 s each.

## Verified, and not

* Real daemon and CLI: a read after restart returned `refreshing: true`,
  `pull-request-detail-updated` followed, the re-read had a new `fetched_at` and no flag; an
  unknown number blocked and returned not_found; `pr refresh` and the `pr merge` confirmation
  fetched (`background=false`), and without `--yes` nothing was sent.
* Fake GitHub only: refresh failure, merged, closed, deleted, force-push, rate-limit pause,
  warm SQLite, `cacheVersion`, two readers (50 concurrent), the tiers, under `-race`.
* Mock only: scroll, tab, readiness, checks, banner, cue, the PRs skeleton.
* Not run: the built Wails GUI against a real daemon, a real rate limit, a real force-push, and
  a read timed during a steady-state poll.

## Gotchas

* A panel's `fetched_at` moves on every background fetch now, so `pr.refresh`-style "updated"
  hints stay honest, but it costs one extra local re-read per stale open.
* The fake runner records a call when it returns, so a held request does not show in `count`;
  tests wait on `inflight` instead. `settleWorker` queues as a background job so it lands behind
  the refreshes it waits for: a waited-for job would jump them.
* Port 7799 may be another worktree's mock: run e2e with `E2E_MOCK_PORT` and `E2E_VITE_PORT`.

## Tests

* `pr_detail_stale_first_test.go`: answers while GitHub is held (aged, moved, merged, closed,
  force-pushed), fetch failure and deletion, pause, coalescing, queue order, read after write,
  decisions, poll tiers, other cache version, the log line, a concurrent run.
* `TestFullPullRequestCache`, `TestFullPullRequestSQLiteRowStartsStale` and
  `TestFullPullRequestConfirmedByPoll` were rewritten for the read that no longer waits;
  `TestFullEntryServes` gained the tier rows. The merge, draft and revert tests pass unchanged.
* `commands_pr_merge_test.go`, `gh_detail_test.go`, `plugin_checks_test.go`: the confirmation's
  refresh, the field, the `Unchanged` skip.
* vitest: `PullRequestSurface.test.tsx`, `readiness.test.ts`, `pageModel.test.ts`,
  `PullRequestsPage.test.tsx`.
* `e2e/pr-stale-first.spec.ts`: scroll only (plus the SHOTS screenshots). The mock's
  `gh/pr-stale`, `gh/dashboard-cold` and `gh/dashboard-warm` drive it.
