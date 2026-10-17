# gh store: six months of exact monthly stats, kept in sync with merges

Status: done on `cf/gh-stats-months` (PR 3 of 3 after #152 and #155). `make check` is
green. Run end to end on 2026-10-17 with a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cfsm-home`,
`daemon --dev`, this repository registered, default 60 s poll) and the built GUI against
it. Nothing changes visually: the Pull Requests page still shows this month and last.

## What changed

* **Shape.** `MonthlyStats.Months` is a list of `MonthCount` ("YYYY-MM", commits,
  merged), newest first, `statsMonths = 6` deep (the current month plus five closed
  ones), globally and per tracked repository. `CommitsSource`, `FetchedAt` and
  `LastError` stay; `ClosedAt` (when the closed months were last fetched) is new and
  internal. Each `MonthCount` keeps its own commit source (internal), and
  `CommitsSource` is `contributions` when any month used the fallback.
* **Proto.** `ActivityStats.this_month`/`last_month` (1, 2) are reserved; `repeated
  MonthActivity months = 6` replaces them, newest first. The message keeps its name
  `MonthActivity` (the brief said `MonthStats`; renaming would only churn the generated
  code). The GUI maps `months` in `src/api/gh.ts`; the page reads `statsMonth(stats, 0)`
  and `statsMonth(stats, 1)`, which give an empty month when not fetched.
* **Exact per-repository merged counts.** The 100-node two-month `mergedRecent` list is
  gone. Each tracked repository has a `first: 0` search per month,
  `repo:owner/name is:pr is:merged author:<me> merged:<range>`, reading `issueCount`
  only (alias `r<i>_m<k>`). Global merged counts are `m<k>`, commits per repository are
  `history { h<k> }` on the default branch, and `contributions { c<k> }` is the global
  commit fallback. On Alex's account this month the old list would already have been a
  lower bound: 153 merged in October.
* **Two cadences.**
  * The **current month** rides in the poll document every `StatsInterval` (15 min). The
    next one is capped at the next month's start, so a rollover is picked up at
    00:00, not up to 15 min later.
  * The **closed months** are fetched when `closedDue`: `HistoryInterval` (24 h,
    `DefaultHistoryInterval`) since `ClosedAt`, or `ClosedAt` before the current month
    started (a rollover), or a closed month missing (first run, a newly tracked
    repository). This is checked per part: the global stats and each repository.
  * `applyStats` lays the fresh months over the held ones by label (`mergeMonths`), so
    cached closed months survive a current-month-only poll.
  * REST `search/commits` runs once per month fetched: 6 on the first run and daily, 1
    per 15 min otherwise. After the first REST failure, the remaining months keep their
    `contributionsCollection` counts.
* **Stats due on a merge.** `statsDueNow` makes the next poll carry the current month,
  without touching the daily closed months. It is called in two places:
  * `MergePullRequest`, when the merge went through;
  * `applyPoll`, when the recently merged list gains a pull request the viewer authored
    and merged this month (or whose merge time is unknown: a placeholder). It compares
    ids against the previous snapshot's list. It is skipped when the poll itself carried
    stats, when there was no previous list (first poll), and when dashboards were off.
* **Cache.** `cacheVersion` 3: old rows are ignored once, and every gh row refetches
  after the upgrade. The global stats row and each repository's stats row are written
  whenever they are fetched. Their `FetchedAt`/`ClosedAt` schedule the next fetch after
  a restart, and the cached six months are served at once.
* **Logs.** The `gh poll` debug line gained `poll_dur` (the poll request alone) and, when
  stats ran, `stats_months`, `stats_merged_searches`, `stats_closed_requests` and
  `stats_dur`. `stats_dur` covers the closed-month requests and the REST searches, paced
  1 s apart by MinGap. `gh closed-month stats` (debug) names each closed request's
  repositories, and its `gh request query=poll_stats` line has its duration.
  `gh stats due` (debug) gives the reason (`merged`, `merge observed`) and the PR.

## Deviation: closed months in their own requests

The brief kept everything in the single poll document. Measured against GitHub, that
does not fit its ~10 s budget for more than a few repositories:

| Stats-only document (curl, median of 3, 2026-10-17) | Time |
|---|---|
| Alex, 1 repository, current month (2 searches, 1 history, 1 contributions) | 0.82 s |
| Alex, 1 repository, 6 months | 2.39 s |
| mitchellh, 4 repositories, current month | 1.58 s |
| mitchellh, 4 repositories, 6 months (30 searches, 24 histories, 6 contributions) | 6.02 s (5.30–7.41) |
| mitchellh, 4 repositories, 6 months, merged searches only (30) | 3.98 s |
| mitchellh, 10 repositories, 6 months, merged searches only (66) | 7.64 s |
| mitchellh, 10 repositories, 6 months, everything | **HTTP 504 after 11.3 s** |
| mitchellh, 10 repositories, current month (11 searches, 10 histories) | 2.32 s |
| mitchellh, closed months only: global + 4 repositories (25 searches, 20 histories, 5 contributions) | 4.84 s (3.36–6.05) |
| Alex, closed months only: global + 2 repositories (the fixture plan) | 2.29–2.52 s |

A `first: 0` search costs **~115 ms** of server time, serially (not ~50 ms). A month of
`history(author:)` costs ~85 ms. A busy account's dashboards already take ~3 s of the
poll. So:

* The poll carries the **current month** only: 1 + N searches, N histories and one
  contributions month. That is ~0.2 s per tracked repository, about what the old two
  `history` counts per repository cost.
* Due **closed months** go in their own `PollStats` documents (`pollPlan.statsOnly`,
  built by `closedPlans`). Each takes at most `closedReposPerRequest = 4` repositories,
  and the first also carries the global closed months: ≤ ~5 s, cost 1 point each, once
  a day.
* A failed closed request is logged and leaves its months and `ClosedAt` unchanged, so
  the next stats poll (15 min) asks again. The current month still applies.

## Measured end to end (2026-10-17, CDT, scratch daemon log; fields trimmed)

First stats poll after `repo.add` (fresh home): the poll carries the current month (2
merged searches), and one closed-month request follows.

```
05:31:39.156 DEBUG "gh request" query=poll dur=1.755s cost=1
05:31:48.426 DEBUG "gh request" query=poll_stats dur=2.121s
05:31:56.315 DEBUG "gh poll" requests=11 cost=5 details=50 dur=18.914s poll_dur=1.755s tier=foreground
                   stats=true stats_months=1 stats_merged_searches=2 stats_closed_requests=1 stats_dur=11.008s
```

(`requests=11`: poll, 3 detail batches for the first 50 PRs, the closed request, 6 REST;
`stats_dur` is mostly the 6 REST searches paced 1 s apart.)

Every later stats poll (ten of them, 05:47 to 08:06, every ~15 min 25 s) carried the
current month only, with no closed request:

```
05:47:21.533 DEBUG "gh poll" requests=2 cost=1 dur=3.568s poll_dur=2.048s stats=true stats_months=1
                   stats_merged_searches=2 stats_closed_requests=0 stats_dur=1.513s
06:02:46.207 DEBUG "gh poll" requests=2 cost=1 dur=3.189s poll_dur=1.877s stats=true stats_months=1 ... stats_dur=1.307s
08:06:11.279 DEBUG "gh poll" requests=2 cost=1 dur=3.773s poll_dur=2.295s stats=true stats_months=1 ... stats_dur=1.473s
```

The poll with the current-month stats took 1.85–2.51 s (`poll_dur`), against a median of
1.54 s (1.11–2.31, n=146) without stats: the stats part costs ~0.5 s of the poll here (2
searches, 1 history, 1 contributions month). `stats_dur` (1.3–1.9 s) is the one REST
search plus its 1 s MinGap pacing. The closed months were not refetched during the run:
the daily refresh is covered by `TestPollStatsSixMonths`.

**Merge observed.** With the daemon stopped, #155 (the viewer's, merged 2026-10-17) was
removed from the cached dashboard row in SQLite, and the daemon was restarted. The first
poll after the restart saw it come back to the recently merged list and marked the
stats due; the next poll carried the current month:

```
08:17:30.389 DEBUG "gh stats due" reason="merge observed" pr=alexwaumann/code-foundry#155
08:17:30.393 DEBUG "gh poll" requests=2 details=1 dur=3.034s stats=false
08:18:33.440 DEBUG "gh poll" requests=2 dur=3.05s poll_dur=1.761s stats=true stats_months=1 stats_closed_requests=0 stats_dur=1.285s
```

The `MergePullRequest` trigger was not run live (it would merge a real PR); it is covered
by `TestMergeMakesStatsDue`.

The Pull Requests page in the built GUI showed October (1544 commits, 153 merged) and
September (0, 0) tiles from `months[0]` and `months[1]`, as before.

## Gotchas

* **Pre-existing race, fixed.** `Track` set `statsNext = now`. A poll that took its
  `start` time just before `Track` but planned just after saw the repository tracked
  and the stats not yet due. It then cleared `pollAgain`, so the stats waited a full
  interval. `go test -race` hit this every time in the new store test. `Track` and
  `statsDueNow` now set `statsNext` to the zero time.
* GraphQL rejects `user(login:) { }` with an empty selection, so `contributions` is
  emitted only when the plan asks for global months (a closed request for repositories
  only has none).
* History `until` is the next month's start for closed months. The current month has
  no `until`, decided by label (`months[0]` of `all`), not by alias index, because a
  closed request's `h0` is a closed month.
* The GUI auto-starts a daemon (without `--dev`, so info-level logs only) when its own
  daemon goes away. To restart a scratch `--dev` daemon under a running GUI, start the
  new one right after the old exits; a launch that loses the race exits with "another
  daemon is already running" and truncates the log file it was redirected to.
* The search's `merged:` range and `history(since:, until:)` use the daemon's time zone;
  `contributionsCollection` buckets by UTC day, so it stays the fallback.
* The fixtures' stats part (`m<k>`, `r<i>_m<k>`, `contributions`, `r<i>.history`) was
  recaptured on 2026-10-17 and spliced into `poll_partial.json` and
  `poll_populated.json`; the rest of each capture is unchanged. The fixture plan still
  asks for six months in one document, a shape `build` supports and the store no longer
  sends. `TestDumpQueries` also writes `poll_stats_me.json`, a closed request body.

## Tests

* `TestMonthWindowsSix`: six months across a year boundary, from the first second of a
  year, with a leap February; contiguous windows.
* `TestClosedDue`: never fetched, fresh, just under and at 24 h, only the current month
  held, a closed month missing, a month rollover 90 min after the last fetch.
* `TestMergeMonths`: current replaced and closed kept, a rollover (kept by label, new
  oldest month zero), nothing held; `commitsSource`.
* `TestPlanPollStatsMonths`: nothing cached, fresh, a day old, a newly tracked
  repository (only its closed months), global only, rollover, not due. The poll always
  carries the current month only.
* `TestClosedPlans`: chunking by 4 with the global months in the first; each document
  passes `checkDoc`, is named PollStats, and its histories end at the next month.
* `TestDecodeStatsCounts`: exact per-repository counts (140 in a month), an empty
  repository, a failed per-repository search (partial error), a missing global count.
  `TestDecodePoll{Populated,Partial}` decode the recaptured six months.
* `TestPollStatsSixMonths` (store): the first stats poll asks for six months globally and
  per repository and makes 6 REST searches, with values bucketed per month. A due poll
  asks for the current month only and keeps the closed months and `ClosedAt`. A restart
  serves the cached six months before any poll and then asks for the current month.
  A day later everything is asked for again. A newly tracked repository gets its closed
  months alone. A failed closed request keeps `ClosedAt`, and the next stats poll asks
  again.
* `TestPollStatsDueOnObservedMerge`: someone else's merge, the viewer's merge last month,
  and the viewer's merge this month; only the last makes the next poll carry the current
  month.
* `TestMergeMakesStatsDue`: a merge marks the stats due; a refused one does not.
* `TestPollPlanBuild`: the six-month, current-month, and no-author documents.
* api `TestStatsToProto` and the GetDashboard/GetRepoActivity tests; frontend
  `mapping.test.ts` maps six months and empty stats.
