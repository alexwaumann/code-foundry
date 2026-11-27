# gh store: bounded read-only concurrency lane

Status: implemented on branch `perf/gh-read-lane` (PR C1).

Previously, even with poll yielding (`yield.go`, `docs/notes/pr-queue-priority.md`), a
user-waited read that arrived while a slow poll fingerprint, stats query, or detail batch
(1.5–5.5 s of GitHub server time) was already in flight still had to wait for that
in-flight HTTP request to finish plus `UserGap` before its own request could be sent.

Now the store runs a single extra **read-only** concurrency lane (`read_lane.go`) sharing
the existing HTTP/2 `*http.Client`, so user-waited reads overlap with an in-flight
read-only primary request instead of blocking behind it.

## Architecture

### Lane lifecycle and dispatch (`internal/store/gh/read_lane.go`)

* `Store.Run(ctx)` spawns one read-lane goroutine (`runReadLane(ctx)`) alongside the
  primary worker loop (unless the test/benchmark option `Options.disableReadLane` is set).
  On cancellation, `Store.Run` waits for `runReadLane` to finish any claimed job before
  closing `HTTPRunner` (`defer s.shutdownRunner()` runs after `defer readWG.Wait()`).
* **At most 1 job runs on the read lane at a time** (at most **2** GitHub requests in
  flight total across primary + read lane, multiplexed over the existing HTTP/2 client).
* The read lane only claims a job when ALL of the following hold under `s.mu`:
  1. `s.primaryInFlightRead == true` — the primary worker is currently blocked inside a
     read-only GitHub network call (`GraphQL` query, `REST` GET, or `RESTRaw` GET). When
     the primary worker is idle or sitting in a gap, it serves reads directly with 1
     request in flight.
  2. `!s.primaryWriting` — no write/mutation is waiting to run or in flight on the primary
     worker.
  3. `!s.authBad && s.pausedLocked() == nil` — no auth failure, rate-limit pause, low-budget
     pause, or network pause is in force.
  4. The queued job is eligible (`job.readLaneEligible()`):
     `j.read && !j.background && len(j.waiters) > 0 && j.kind != jobPoll && j.kind != jobAuth && j.id != "poll_projects"`.
     Eligible reads: `FullPullRequest`, `PullRequestDiff`, `PullRequestFile`,
     `PullRequest` / `LookupPullRequest`, `Checks` pagination, `ReviewerCandidates`,
     `SearchRepositories`, `LookupRepository`, `PublishOwners`, and `freshBody`
     (read-only description pre-read). Excluded: all mutations (`submitFunc`), `RESTWrite`,
     `jobPoll` / `Refresh(slug)`, `jobAuth`, `poll_projects`, and promised background
     refreshes with 0 active waiters.
  5. `s.allowance.left(now)` — the shared `gapAllowance` token bucket has at least 1 token
     available. When the bucket is empty, user-waited reads fall back cleanly to the
     primary worker (`yield.go` + `MinGap`).
  6. `s.lastEnd.Add(s.opts.UserGap) <= now` — consecutive read-lane dispatches stay spaced
     by at least `UserGap` (250 ms) so bursts never fire back-to-back at 0 ms. If a gap
     remains, `claimReadLane` returns `(nil, wait)` without claiming so callers can still
     `abandon` cleanly during the wait.
* **Context-carried lane marker**: `runReadLane` tags its context with `withReadLane(ctx)`.
  `callDocMeta`, `admit`, `restRaw`, and `orgPolicy` inspect `isReadLane(ctx)`:
  * Read-lane calls enter `admitReadLane(ctx, read)`, which rejects writes
    (defense-in-depth), rejects paused state with `notSent{err}`, spends a `gapAllowance`
    token at `UserGap` spacing when available, and falls back to shared `MinGap` pacing
    (advancing `s.lastEnd`/`s.lastStart` under `s.mu` rather than waiting up to 10 s for
    token refill) on follow-up pages of an already-claimed multi-request job.
  * Read-lane calls never read or write worker-only fields (`cycle`, `scheduled`,
    `forUser`, `ahead`, etc.).

### Strict write serialization

* All writes (GraphQL mutations via `submitFunc` and REST writes via `restWrite`) have
  `j.kind == jobFunc && !j.read` (`isWriteJob(j) == true`) and run strictly on the primary
  worker:
  * **Before a write runs**: `execute` calls `enterWrite(ctx)`, which sets
    `s.primaryWriting = true` (immediately preventing new read-lane claims) and waits on
    `s.readLaneDone` until any in-flight read-lane job completes (or `ctx` is cancelled).
  * **During a write**: `s.primaryInFlightRead` is never set for mutations or `restWrite`,
    and `s.primaryWriting` stays `true`, so no read-lane job can start concurrently with
    `patchFull`, `localOverlay`, or GitHub writes.
  * **Spacing**: `admit(ctx, false)` enforces `>= MinGap` (1 s) after `s.lastEnd`
    (updated monotonically by both lanes), keeping writes strictly serial and spaced.

### In-flight deduplication and abandonment

* Active read jobs claimed by either lane (including background `refreshFull`, excluding
  `LookupPullRequest` which sets `noDedup` to preserve its "ask GitHub now" contract) are
  registered in `s.inflight` (keyed by `j.key()`, protected by `s.mu`).
* `enqueueLocked` checks `s.inflight` first for user-waited reads (when `!active.background`):
  a concurrent caller for the same key joins `active.waiters` directly instead of queuing a
  duplicate request. And `claimReadLane` refuses to claim a job whose key is already in
  `s.inflight` on the primary worker (e.g. a background `refreshFull`), so a user read never
  races an in-flight background refresh for the same pull request.
* `abandon` removes a cancelled caller's channel from either `s.queue` or `s.inflight`;
  in-flight jobs finish normally for any remaining waiters and populate the cache.
* `finishJob` atomically removes `j` from `s.inflight` and detaches `j.waiters` under
  `s.mu` before sending results to the buffered channels.

### Poll fingerprint vs concurrent read-lane causality

* Every GraphQL request captures a monotonic sequence number (`s.reqSeq.Add(1)`) and send
  timestamp (`start`) right after `admit` returns (`callDocMeta` / `callMeta`).
* `fullEntry` (`s.full`) and `detailEntry` (`s.prDetails`) record `fetchSeq`, and
  `putWithSeq` never lets a late older-seq response overwrite a strictly newer-seq entry.
* `runPoll` and `pollProjects` pass their fingerprint request's `(known, fpSeq)` into
  `staleFullDetails` (`fullCache.applyPollAt`) and `markMovedDetails`:
  * In `fullCache.applyPollAt`: moving fingerprints record `movedSeq[k] = fpSeq` so a late
    response from `fetchSeq < fpSeq` lands as `stale: true`. Entries with `e.fetchSeq > fpSeq`
    are left untouched when they have a strictly newer `UpdatedAt` or match `f`; when
    `UpdatedAt` is equal but check counts/rollup differ (checks do not bump `UpdatedAt`),
    `checksStale` is set so open panels refresh `checks.graphql` cheaply.
  * In `markMovedDetails`: marks are stamped at apply time with `fpSeq` (`moved.markSeq`),
    and skipped only when `s.prDetails.newerThan(k, fpSeq, f)` confirms an in-memory detail
    fetched after `fpSeq` already reflects or supersedes `f`. `PullRequest` checks
    `movedSinceSeq(k, cached.FetchedAt, fetchSeq)`, so late pre-poll fetches are also
    invalidated.

## Thread-safety audit

| State | Owner / Synchronization | Touched by read lane? |
|---|---|---|
| `scheduled`, `forUser`, `ahead`, `searchFirst`, `detailBatch`, `recheck`, `appearing`, `failingKey`, `searchAsID`, `cycle` | Primary worker goroutine only | Never |
| `lastEnd`, `allowance`, `pauseUntil`, `pauseErr`, `authBad`, `authNext`, `authFailures`, `globalFailures`, `lastResetAt`, `queue`, `stopped`, `primaryInFlightRead`, `primaryWriting`, `readLaneBusy`, `readLaneDone`, `inflight` | `Store.mu` | Yes (under `s.mu`) |
| `reqSeq` | `atomic.Uint64` | Yes (atomic) |
| `snap` / `snapMu` | `atomic.Pointer[Snapshot]` + `snapMu` | Read-only (`Snapshot()`) and `setAuthenticated` via `noteResult` (serialized by `snapMu`) |
| `full`, `prDetails`, `summaries`, `prFiles`, `reviewers`, `owners`, `moved` | Each cache's own `sync.Mutex` | Yes (all mutex-protected) |
| `localShown`, `branches` | Own `sync.Mutex`; mutated only on primary worker | Never mutated by read lane |
| `s.cache` (`*sql.DB`) | SQLite WAL + `busy_timeout(5000)`, Go `database/sql` pool | Yes (concurrent reads/writes safe) |
| `s.opts.Runner` (`HTTPRunner`) | `resolveMu`, `mu`, concurrent `*http.Client` (HTTP/2) | Yes (documented concurrency-safe) |
| `s.opts.Rand()` | Called only while holding `Store.mu` | Yes (serialized by `s.mu`) |
| `s.opts.Bus` (`*bus.Bus`) | Thread-safe pub/sub | Yes |

## Runaway hourly and per-minute budget proof

Corrected 2026-11-27. The first version of this section gave 3,368 requests an hour at
0.2 s RTT and 3,968 at zero RTT. It counted one request per read-lane token and put
every tokenless follow-up page inside the primary lane's serial time. Neither holds in
the code, so the bound below is higher. It is derived from `pace.go`, `yield.go` and
`read_lane.go` as they stand. No pacing code changed with this correction.

GitHub's limits (`docs/notes/gh-http-transport.md`, `docs/notes/pr-queue-priority.md`):

* **Primary GraphQL budget**: 5,000 points/hour, at least one point per request.
* **Primary REST core budget**: 5,000 requests/hour, separate from GraphQL.
* **Secondary limits**: 100 concurrent requests, 2,000 GraphQL points/min, 900 REST
  requests/min, serial writes spaced >= 1 s.

### What sends requests

* **Primary worker.** Everything not on the read lane: the poll and its follow-ups
  (detail batches, failing checks, stats, projects), the hot poll, the auth check (REST
  `GET /user`), every write, and user reads the read lane did not take. One request in
  flight. `admit` waits until `lastEnd + gap`, where the gap is `MinGap` (1 s), or
  `UserGap` (0.25 s) for a user-waited read while a token is left. So consecutive primary
  starts are at least `gap + d` apart, where `d` is the RTT.
* **Read lane.** One job at a time. It claims a job only while the primary is inside a
  read, a token is left and `lastEnd + UserGap` has passed. The claim spends nothing.
  Each request then goes through `admitReadLane`. With a token left, it spends the token
  and waits for `lastEnd + UserGap`. Without one, it waits for
  `max(lastEnd, lastStart) + MinGap` and moves `lastEnd` to its own start. Either way
  the job runs to the end, token or not.
* **Outside both.** Keep-warm's `HEAD /rate_limit` runs at most once per 20 s, on a
  presence rise, and `/rate_limit` does not count against the primary limit. Nothing else
  sends requests.

### What the first proof missed

1. **Tokenless pages run beside the primary, not inside its serial time.** The old
   proof said they "reserve a full `MinGap` slot on the shared clock". Two things stop
   that from happening:
   * The primary's `admit` computes its wait once, from `lastEnd` as it stands
     (normally the primary's own last end). When the timer fires, the wait ends without
     re-reading `lastEnd`. The primary never looks at `lastStart`.
   * The read lane also computes its wait once.

   So each lane paces off its own last end, and the two interleave, each at one request
   per `MinGap + d`. The read lane's reservation only delays a primary request whose wait
   is computed after the reservation. The worker's job loop (`next()`) re-checks between
   jobs, so a primary running one-request jobs is partly held back. A primary inside a
   multi-request job is not held back: a poll's detail batches and check pages, or a
   detail fetch.

   This was measured on 2026-11-27 with a throwaway harness test, not committed, using
   `fakeRunner`, which sleeps each request. The pacing was `MinGap` 100 ms, `UserGap`
   25 ms and a 20 ms fake RTT, the production ratios scaled by 0.1, over a 3 s window:

   | Load | Requests in 3 s | In flight at most | Shortest start-to-start |
   |---|---|---|---|
   | one 1,000-page `PullRequest` job, read lane off | 24 (3 s / 120 ms) | 1 | 121 ms |
   | one such job on each lane | 48 (24 + 24) | 2 | 20 ms |
   | the read-lane job beside a primary running one-request polls back to back | 34 (read lane 24, primary 10) | 2 | 18 ms |

2. **A claim is one token, but its job can be several requests.**
   * `PullRequest` and `LookupPullRequest`: at most `MaxPages` = 4.
   * `FullPullRequest`: at most 5. A checks-only page can find CI settled or the commit
     gone. The full detail follows, with up to `MaxPages - 1` = 3 more check pages.
   * `PublishOwners`: 1 GraphQL request, plus one REST `GET /orgs/{org}` for each
     organization the viewer may create repositories in (up to 100).
   * Diff, file, reviewer candidates, search, lookup and body: 1.
3. **REST is its own budget, and the `MinRemaining` pause does not cover it** (below).

The later review's figure of about 4,450 is the 4-page case:
3,000 + 368 × 4 = 4,472. The detail fetch's fallback makes 5 requests, which gives the
figure below.

### Hourly bound

`d` is the RTT. The shortest warm GitHub RTT measured is about 0.20 s
(`gh-http-transport.md`). `T = userGapBurst + 3600 / userGapRefill = 8 + 360 = 368`
tokens an hour. `T` also bounds read-lane claims: each claim needs a token left, and
its first request spends it.

**GraphQL (5,000 points/hour):**

* **Primary**: at most `3600 / (1 + d)` requests, which is 3,000 at d = 0.2 s. A token
  spent on a primary short read saves 0.75 s, which is worth less than one request. So,
  as before, the worst case spends every token on the read lane.
* **Read lane**: at most `T × 5 = 1,840` GraphQL requests, from 5-request detail jobs. A
  `PublishOwners` job brings only one GraphQL request. Timing check: a 5-request job
  takes 0.25 + d + 4 × (1 + d) = 5.05 s at d = 0.2 s, inside the 10 s refill. So the
  token, not the lane's own pacing, is what limits it.
* **Total**: at most **3,000 + 1,840 = 4,840 requests/hour at d = 0.2 s**, a margin of
  160 under 5,000. At d = 0 it is 3,600 + 1,840 = 5,440. Pacing alone keeps GraphQL under
  5,000 only while `3600 / (1 + d) <= 3,160`, which is d >= 0.139 s.
* Reaching this needs a primary that never idles (a runaway schedule or client) beside a
  detail fetch every 10 s. Each of those fetches would have to take the
  checks-only-then-full path on a commit with over 300 checks.

**REST core (5,000 requests/hour):**

* **Primary REST**: diff and file reads (`restRaw`), `GET /orgs/{org}`,
  `search/commits` for the stats, and the auth check. That is at most 3,000 if a runaway
  client kept the primary in REST reads.
* **Read lane REST**: `PublishOwners` with many organizations keeps the lane busy at its
  own pace. That is `(3600 - T × (0.25 + d)) / (1 + d) + T = 2,862 + 368 = 3,230`
  requests at d = 0.2 s, almost all of them REST. This needs the owners result to come
  back incomplete every time (a transient error on some organization), because a
  complete result is cached for 10 minutes.
* **Total**: up to about **6,200 REST requests/hour at d = 0.2 s, above 5,000**. Only a
  runaway client reaches it.

**Finding (not fixed here).** Without the pause, the true worst case can exceed 5,000:
GraphQL at RTTs under about 139 ms, and REST at the measured RTT in the runaway case
above. Before this correction, the text said the pacing alone kept every case under
5,000.

### What backstops it

* **GraphQL**: every response, on either lane, carries `rateLimit`. When
  `remaining < MinRemaining` (200), `noteResult` pauses both lanes until `resetAt + 5 s`.
  This pause, not the pacing, keeps a runaway GraphQL hour inside 5,000 points. That
  matters for multi-point queries too, since the bound above counts requests.
* **REST**: REST responses give `noteResult` no `rateLimit`, so `MinRemaining` never
  applies. An exhausted REST budget (`x-ratelimit-remaining: 0`, which `HTTPRunner`
  turns into a `RateLimitError`) pauses the store only through `restRaw` (diff, file).
  `orgPolicy` and `searchCommits` pass only auth and network errors to `noteResult`. An
  exhausted budget seen there pauses nothing, and later REST requests fail until the
  reset.

### Per-minute window (secondary limits)

* Both lanes at `MinGap + d`: 2 × 60 / 1.2 = 100 requests a minute. Add at most
  8 + 60 / 10 = 14 token-paced ones, for about **114 a minute at d = 0.2 s** (134 at
  d = 0).
* That is 6–7% of the 2,000 GraphQL points/min limit and 13–15% of the 900 REST
  requests/min limit.
* Concurrency is at most **2** in flight, against GitHub's 100: the read lane is one
  goroutine and the primary is one worker.
* Rate-limit pushback: any `*RateLimitError` that reaches `noteResult` on either lane
  pauses both lanes. It also calls `s.allowance.exhaust(now)` under `s.mu`, which empties
  all 8 tokens.

## Real measurements (2026-11-25, Apple M3 Pro, darwin/arm64)

### 1. Controlled harness with realistic GitHub timings

Measured via `go test -run '^$' -bench 'BenchmarkReadLane' -benchtime=3x -count=1 ./internal/store/gh`
(`perf_bench_test.go`), comparing `disableReadLane: true` (before) vs `disableReadLane: false`
(after) with production pacing (`MinGap = 1 s`, `UserGap = 250 ms`), 200 ms simulated user
read RTT, and user reads arriving 50 ms after a slow poll starts:

| Scenario (`n = 3` each) | Metric | Before (single lane) | After (read lane) | Improvement |
|---|---|---:|---:|---:|
| Single `FullPullRequest` during 1.5 s poll | Queue wait | 1,702 ms | **0.3 ms** | **-1,702 ms** (-99.98%) |
| Single `FullPullRequest` during 1.5 s poll | Total latency | 1,906 ms | **203.7 ms** | **9.4x faster** (-89.3%) |
| Single `FullPullRequest` during 2.0 s poll | Queue wait | 2,202 ms | **0.3 ms** | **-2,202 ms** (-99.99%) |
| Single `FullPullRequest` during 2.0 s poll | Total latency | 2,405 ms | **204.0 ms** | **11.8x faster** (-91.5%) |
| Burst of 3 reads (`FullPullRequest`, `PullRequestDiff`, `ReviewerCandidates`) during 2.0 s poll | First read | 2,404 ms | **202.3 ms** | **11.9x faster** (-91.6%) |
| Burst of 3 reads during 2.0 s poll | All 3 complete | 3,313 ms | **1,111 ms** | **3.0x faster** (-66.5%; all 3 finish before the 2.0 s poll returns) |

### 2. Live read-only GitHub measurement (`alexwaumann/code-foundry` #904)

Measured via `GH_LIVE_MEASURE=1 go test -v -run '^TestReadLaneLiveMeasurement$' -count=1 ./internal/store/gh`
against live `api.github.com` over HTTP/2 (`FullPullRequest` arriving 50 ms into a cold
tracked-repo poll):

| Mode | `FullPullRequest` latency | Poll total duration |
|---|---:|---:|
| Before (`disableReadLane: true`) | 3,663 ms | 8,428 ms |
| After (`disableReadLane: false`) | **959 ms** (**3.8x faster**, -2,704 ms) | 7,474 ms |

## Tests and verification

* `internal/store/gh/read_lane_test.go`:
  * `TestReadLaneOverlapsSlowPollForAllEligibleReads` (all 8 eligible user-waited read
    APIs completing while a poll is held in flight, `maxInflight == 2`).
  * `TestReadLaneOverlapsSlowDetailBatchWithPaginatedChecks` (multi-page `Checks`
    pagination completing on read lane during a held `PullRequestDetails` batch).
  * `TestReadLaneExcludesIneligibleJobs` (`Refresh(slug)`, background `refreshFull`,
    GraphQL mutation, `RESTWrite` never use the read lane).
  * `TestReadLaneWriteSerialization` (reads wait while GraphQL mutation or `RESTWrite` is
    in flight; writes drain any in-flight read-lane job and pay `>= MinGap` before starting).
  * `TestReadLaneGlobalPausePropagation` (rate limit, low budget, auth error, network error
    on either lane immediately stop both lanes without sending refused requests).
  * `TestReadLaneAllowanceExhaustionFallsBackToSerial` (first 8 burst reads run on read
    lane; reads 9–12 queue and fall back to primary serial pacing).
  * `TestReadLaneInflightDedupAndAbandon` (in-flight coalescing across callers, cancelling
    an in-flight waiter, abandoning a queued read when both lanes are busy).
  * `TestReadLaneShutdownAndCancellation` (cancelling `Store.Run` with both lanes in flight
    drains cleanly with no goroutine leak).
  * `TestReadLanePollFingerprintCausality` (overlapping older poll fingerprint does not
    falsely stale/invalidate fresher `FullPullRequest` or `PullRequest`; strictly newer
    poll fingerprint still stales an older fetch).
* Existing `yield_test.go` and `pr_detail_stale_first_test.go`:
  * Tests that explicitly hold a poll to pin single-lane `yield.go` queuing / fallback
    behavior (`TestClickDuringEveryStageOfAPoll`, `TestBurstOfClicksDuringAPoll`,
    `TestPollCancelledWithAJobQueued`, `TestShutdownWhileYielding`, `TestCallerLeaves`,
    `TestEveryReadLeavesWithItsCaller`, `TestPollDoesNotStaleWhatAClickFetched`,
    `TestRefusedStatsAreNotAResult`, `TestPauseInAYieldLeavesTheProjectListsAlone`,
    `TestPauseStopsThePollAndTheQueue`, `TestRefreshJoiningAReadStillAnnounces`,
    `TestYieldInThePollLogLine`, `TestAbandonedReadSendsNothing`) run with
    `disableReadLane: true` so the fallback path remains fully pinned.
  * `TestFullPullRequestReusesInFlightFetch` now accepts in-flight coalescing in
    `s.inflight` in addition to `s.queue`.
  * `TestQueueUnderLoad`, `TestStreamOfJobsDoesNotStarveThePoll`,
    `TestStatsAskedDuringAStatsPoll`, `TestClickDuringThePollsGap`, and all write/pause
    tests run with the read lane enabled by default.
