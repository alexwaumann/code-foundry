# Pull request opens no longer wait for the poll

Status: PR 3 of 3 on "PRs load really slow", reported by a user. The store's worker ran a poll
as one job, so a click waited for all of it. Now the poll stops before each of its requests and
lets waiting jobs in. Measured on real GitHub (read only) with a scratch `daemon --dev` and curl
over the socket. Daemon only; the GUI side shipped in #518, which also started the cancellation
this PR builds on.

## What changed

* **The poll yields** (`yield.go`). Every request goes through `admit`. While the worker runs
  scheduled work (the poll, the auth check), `admit` first runs the jobs someone waits for, as
  plain calls on the same goroutine, then the poll carries on. It also watches `s.wake` during
  the poll's gap, so a click that lands there goes before the poll's next request.
* **A short gap for waited reads.** A read someone waits for may start 250 ms (a quarter of
  MinGap) after the previous request, from a token bucket of 8 that refills one per 10 s.
* **Pauses hold for every request.** `admit` refuses while a pause is in force, with the pause's
  error and without sending. This covers the poll's later stages, jobs queued before the pause,
  and the auth check (`next` now waits it out too).
* **A caller that leaves takes its read with it**, through #518's `abandon` and `job.read`: see
  "Item 3" below. A job already running finishes.
* **The queue-wait log line stays.** The debug `gh poll` line gained `yields=` and `yield_dur=`;
  its `dur` includes them, and a yielded job's requests do not count in the poll's numbers.

## Why the yield is on the worker

The alternative was a second goroutine, or splitting the poll into resumable stages. A nested
call keeps every property that the worker gives for free:

* One request in flight, by construction: there is still one goroutine.
* Worker-only fields stay worker-only (`lastEnd`, `recheck`, `detailBatch`, `searchFirst`,
  `failingKey`, `appearing`). No job touches the ones the poll keeps across a yield, checked by
  grep, and `cycle` is saved and restored around a job.
* The poll's state stays on its stack, so there is nothing to resume or to get wrong on resume.

**The rule that makes it safe:** a poll stops only in `admit`, right before a request. Everything
between two requests runs unbroken:

* A fingerprint response and its `staleFullDetails` / `markMovedDetails` are one step, because
  the next chance to yield is the next request. So a job's fetch is never judged by a fingerprint
  older than itself, which would send a newer copy back for a needless fetch.
* The snapshot update and its events are one step, so a publish cannot be split. It is not the end
  of the poll: `pollProjects` runs after it, with requests and yields of its own, and only then
  come `Polled` and the schedule. A job can therefore run after the dashboards are published and
  before `Polled`.
* What the poll holds across a yield is what it asked GitHub before the job ran. The publish does
  not touch the detail cache, so it cannot overwrite a click's result. A write in a yield asks for
  another poll (`pollSoon`, kept by `pollAgain`), and a merge shown meanwhile survives through
  `mergedOverlay.apply`, which already allowed for it.
* `planPoll` clears `pollAgain`, and `resolveWatchedHeads` can yield before it. A write in that
  yield has its `pollAgain` cleared, which is safe because the plan and its requests come after
  the write. Any yield after `planPoll` keeps it.
* Anything a poll schedules at its end must honour a request that came after it planned. `pollAgain`
  always did; `statsAsked` does the same for the stats.

Do not add a yield anywhere else, and do not make a request between a fingerprint and its stale
pass. Only jobs someone waits for go in: background jobs wait for the poll to end, and a queued
poll does too, so polls never nest.

## Item 3: what #518 did, what this adds, what remains

#518 landed mid-way through this PR with `abandon` and `job.read`, so this PR dropped its own
cancellation path and builds on that one. There is one path.

* **From #518:** the detail and diff reads opt in through `submitRead`; a read with no waiter left
  leaves the queue; another live waiter keeps it; writes still run; a refresh joining a queued read
  clears `read`, so it runs whoever gives up.
* **Added here:**
  * Every other read opts in too: `PullRequest`, `Checks`, `PullRequestFile`, `ReviewerCandidates`,
    `SearchRepositories`, `LookupRepository`, `PublishOwners`, and the poll `Refresh(slug)` waits
    for. One table test walks away from each.
  * A promised refresh with nobody left waiting goes back behind the waited jobs (`job.promised`,
    which replaces #518's `read = false` on joining). Without this, a promoted refresh would hold
    its place and run in a yield, ahead of the poll, for nobody.
  * A refresh joining a read hands over its `run`, not only `read = false`. Otherwise it ran with
    the read's closure and said nothing when nothing changed, leaving the client on `refreshing`.
  * `submit` refuses a context that is already dead, so a write nobody asked for any more is not
    queued. `abandon` also ignores a later job of the same key that `ch` never joined.
* **Closed: a queued write whose caller left still runs, and keeps its place.** Decided in review.
  The caller is told `context canceled` while the write still lands, as it always was. An earlier
  revision of this PR moved such a write behind the waited jobs, which reversed two writes: convert
  to draft abandoned, then mark ready, went out as mark ready, then draft, so GitHub ended on the
  action given up. Nothing remains of item 3.

## Decisions

* **Worst case for a click:** the rest of the request in flight, then the short gap, then the
  fetch. In-flight requests are not cancelled: that throws away a request already paid for, and
  a detail batch can be 4-6 s but is rare. A background job does not yield either: it is one
  request unless the pull request has over 100 checks.
* **MinGap: an allowance, not a removal.** GitHub's published secondary limits are 100 concurrent
  requests, 2,000 points a minute for GraphQL (900 for REST), and a query or GET costs 1 point. It
  asks for requests in series, and for at least a second between POST, PATCH, PUT and DELETE
  requests. So for reads the risk is rate rather than spacing, and writes must keep the gap:
  * Only reads with a caller waiting get it. Writes (a `mutation` document, `restWrite`), the poll
    and background jobs pay the full MinGap, and the poll pays it after a job too.
  * The bucket keeps the runaway sum in `pace.go` true: at most 360 more requests an hour on top
    of 3,000, under the 5,000 budget, and the store still pauses at MinRemaining. A worst-case
    minute is about 70 requests against 2,000 points.
  * A token is spent only when the short gap actually saved time.
  * A rate-limit error empties the bucket, so nothing leans on GitHub right after it pushed back.
* **Starvation: `maxJobsAhead` = 8.** At most 8 jobs go ahead of due scheduled work before it gets
  a request, counted in `next` and in yields alike and reset when that work sends one. `next` had
  this bug already: any queued job beat a due poll, forever. A poll of R requests ends within
  R x 9 requests under any stream. A burst of 50 pays one poll request per 8 jobs.
* **A background job can still wait behind a steady stream of waited jobs.** That is #513's rule,
  kept: a person stops clicking.
* **The pause gate goes beyond #514's pollProjects check, deliberately.** A job in a yield can set
  a pause mid-poll, so the poll's later requests needed it whatever #514 does. The two fit: #514's
  check returns first and leaves the lists as they were, and the gate catches everything else,
  including a pause set by a job that ran in the yield just before the projects request.
* **A poll's own low-budget or rate-limit answer now stops its later stages too.** Before, details,
  failing checks and stats went out after it. They end as a failed request does: the poll publishes
  what it has with the error, and the next poll asks again.
* **`notSent`.** A pause's error can wrap `ErrNetwork`, which `outcomeUnknown` reads as "the write
  may have run". A merge refused by the gate would have said "it may have merged" and been
  remembered, so a refused request says it never left.
* **A refused stats request is no result; search does not go through a pause.** `searchCommits`
  used to skip the pause, and its comment says REST search has its own limit. Letting it through
  would keep the counts fresher, but a pause may be the network's, GitHub's secondary limits span
  both APIs, and the store cannot tell which it has, so "nothing goes out" stays without an
  exception. So a refusal in the closed months or the searches makes `applyStats` return nil: the
  held counts and `ClosedAt` stay, nothing is saved, and `statsNext` does not move, so the poll
  after the pause brings them. The whole pass is dropped, not only the month refused, because a
  half-applied pass is what stamped contributions counts as done until HistoryInterval. A real
  search failure (an answer, not a refusal) keeps its old fallback to contributions.
* **Stats asked for during a poll stay due.** `statsDueNow` and `Track` zero `statsNext`, and the
  poll's end used to overwrite that, so a merge in a yield left the merged count stale for up to
  StatsInterval. `askStatsLocked` sets `statsAsked` too, `planPoll` consumes it, and both ends of
  `applyStats` go through `scheduleStatsLocked`, which leaves a later request alone.
* **A pause set in a yield is the same to the project lists as #514's own-pause case.** A refusal
  of their request, or of their details, returns with the lists and their `LastError` as they were.
* **A merge whose outcome is unknown invalidates on the worker**, as the review path already does.
  This removes the `unknown` variable that a caller leaving mid-merge read while the worker wrote
  it, and also fixes what that race hid: a caller that had left never told clients to re-read.
* **`submit` after Run ended fails** (`s.stopped`) instead of hanging on a context that may never
  end. Run also checks its context at the top of the loop: a refused request sets no `lastEnd`, so
  a poll left due would spin there.

## Measured (2026-11-03, this machine, one account, alexwaumann/code-foundry #500-#510)

`main` at 0484add4c against this branch before its rebase, three fresh scratch homes each,
alternating, with one repository tracked. Every read is uncached. Seconds, median (max). `queue` and `fetch` are from
the #513 log line.

| Uncached open | n | Total before | Total after | queue before | queue after |
|---|---|---|---|---|---|
| During the first poll (5 requests) | 3 | 12.61 (13.69) | 2.74 (2.75) | 11.91 (12.51) | 1.84 (1.85) |
| During the stats poll (9-11 requests) | 3 | 17.86 (19.82) | 2.86 (3.42) | 17.27 (19.32) | 2.06 (2.58) |
| During a steady poll (2-3 requests) | 12 | 5.80 (8.98) | 2.17 (2.77) | 5.20 (7.03) | 1.29 (1.91) |
| Back to back, no poll | 15 | 1.61 (1.83) | 0.81 (0.98) | 0.98 (0.99) | 0.23 (0.24) |

* `queue` after is the rest of the poll request in flight. GitHub was slower than in #513's
  numbers: a poll request took about 2-3 s here, which is what is left of the wait.
* `fetch` went from 0.49-0.70 s to 0.84-0.89 s during polls, because in a yield the short gap
  falls inside `fetch` (`admit`) and not in `queue_wait`. Back to back it is 0.60 s, unchanged,
  with the gap in `queue_wait`.
* The poll itself does not get slower by more than the click. Stats polls took 15.6-18.4 s before
  and 16.9-17.7 s after, each with one yield. Request counts differ with what GitHub moved.
* The steady poll's click lands 0.3 s after asking for the poll.
* One more run on the final tree, after the rebase onto #514 and #518, agrees: 1.76 s during the
  first poll, 2.73 s during the stats poll, 1.96-2.57 s during steady polls, 0.70-1.00 s back to
  back, with `queue_wait` 1.05-1.84 s during polls and 0.22 s back to back.

## Verified, and not

* Real daemon: the table above, reads only. Every request was a poll or `GetPullRequestDetail`.
* Fake GitHub, under `-race`: a click at each of the 7 request kinds, a click in the gap, bursts of
  50 (distinct and identical), a stream before and during a poll, shutdown with a job queued and
  during a yield, a caller leaving queued and running, every read path, publish against a click's
  fetch and a write, pauses from a job and from each poll stage, and a load test of all of these.
  The yield tests ran 5 times over before the rebase.
* Each rule was also broken on purpose, and a test failed for each. After review the same was done
  for each fix: stats asked at each of 5 stages and on the failure path, refused searches and closed
  months, the two writes' order, the project lists' request and details, the merge's invalidation.
* Not run: the built Wails GUI, a real rate limit, a real network pause, or a long-lived session
  with many tracked repositories. The worst case for a click (a 10-pull-request detail batch in
  flight) did not come up in these runs.

## Gotchas

* A job can be claimed at the short gap and still wait in `admit` when it turns out to be a write.
  Its caller can no longer drop it for that moment, at most MinGap.
* `admit` must not re-read the clock after its timer fires: tests freeze `Now`, and it would wait
  forever. It goes straight to the send, which is why a click in the same instant waits one request.
* `goJob` in the tests needs the worker busy, or the job is claimed before it can be seen queued.
* `Track` asks for stats and for a poll, so poll N+1 can start and end by itself. A test that marks
  the request log after poll N's `Polled` can then be looking at poll N+2, which rightly has no
  stats. `TestStatsAskedDuringAStatsPoll` did that and failed on GitHub's runner, and 11 of 400 runs
  here (`-race -count=200 -cpu 1,2`). No request was lost: with the order forced, poll N+1 carried
  the stats and `o/new` had them, while the old window printed the same `[Poll PollProjects]`. The
  test now reads the log by poll (`pollAfter`), and passed 400 of 400. Read such a log by poll,
  never from a mark taken after a poll that may have a follow-up.

## Tests

`yield_test.go`: all of the above, plus the gap table (`TestAdmitGap`), `TestGapAllowance`,
`TestEveryReadLeavesWithItsCaller`, `TestRefusedWriteHasAKnownOutcome`, `TestRunEndsWithAPollDue`,
`TestStatsAskedDuringAStatsPoll`, `TestPlanWaitingForTheViewerKeepsStatsDue`,
`TestRefusedStatsAreNotAResult`, `TestAbandonedWriteKeepsItsPlace`,
`TestPauseInAYieldLeavesTheProjectListsAlone`, `TestMergeCallerLeavesWhileRunning`, and the poll's
log line.
