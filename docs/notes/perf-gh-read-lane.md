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

GitHub's limits (`docs/notes/gh-http-transport.md`, `docs/notes/pr-queue-priority.md`):
* **Primary GraphQL budget**: 5,000 points/hour (shared across the user's token).
* **Primary REST core budget**: 5,000 requests/hour.
* **Secondary limits**: 100 concurrent requests, 2,000 GraphQL points/min, 900 REST
  requests/min, serial writes spaced >= 1 s.

Let:
* $R_{\text{full}}$ = primary-lane requests paying `MinGap` = 1.0 s.
* $R_{\text{short}}$ = primary-lane user-waited reads taking `UserGap` = 0.25 s (each spends
  1 token from `s.allowance`).
* $R_{\text{read}}$ = read-lane requests (every single request on the read lane spends 1
  token from `s.allowance` in `admitReadLane`).
* $d$ = request RTT (shortest warm GitHub HTTP/2 RTT measured in `gh-http-transport.md` is
  ~0.20 s).

Because both $R_{\text{short}}$ and $R_{\text{read}}$ draw from the **single shared**
`gapAllowance` bucket (`userGapBurst = 8`, `userGapRefill = 10 s`):

1. **Token bound over any 1-hour (3,600 s) window**:
   $$R_{\text{read}} + R_{\text{short}} \le 8 + \frac{3600}{10} = 368$$
2. **Primary-lane serial time bound**:
   $$R_{\text{full}}(1.0 + d) + R_{\text{short}}(0.25 + d) \le 3600$$
   Spending a token on $R_{\text{short}}$ saves 0.75 s of primary time (buying at most
   $\frac{0.75}{1.0 + d} < 1$ extra request), whereas spending it on $R_{\text{read}}$ adds
   $+1.0$ request directly. Therefore the worst case spends all 368 tokens on
   $R_{\text{read}}$ ($R_{\text{short}} = 0, R_{\text{read}} = 368$):
   * **At realistic minimum GitHub RTT ($d = 0.2\text{ s}$)**:
     $$R_{\text{full}} \le \frac{3600}{1.2} = 3,000 \implies R_{\text{total}} \le 3,000 + 368 = \mathbf{3,368\text{ req/hr}}$$
   * **Even at theoretical zero RTT ($d = 0\text{ s}$, impossible over HTTPS)**:
     $$R_{\text{full}} \le \frac{3600}{1.0} = 3,600 \implies R_{\text{total}} \le 3,600 + 368 = \mathbf{3,968\text{ req/hr}}$$
   * Tokenless follow-up pages on an already-claimed multi-request read-lane job reserve a
     full `MinGap` (1.0 s) slot on the shared `lastEnd`/`lastStart` pacing clock rather than
     spending tokens, so they count inside $R_{\text{full}}$ and preserve the exact same
     request bound without stalling up to 10 s for a token refill.
   * Note: the pacing bound above is in **requests/hour** (1-point queries match points 1:1;
     heavier multi-point queries are guarded by `noteResult`, which reads `rateLimit.remaining`
     from every GraphQL response on either lane and pauses **both** lanes until `resetAt + 5 s`
     whenever `remaining < MinRemaining (200)`).
3. **Worst-case 1-minute (60 s) window (secondary limit)**:
   * Allowance tokens available in 60 s: $8 + \frac{60}{10} = 14$.
   * Primary lane in 60 s: $\frac{60}{1.2} = 50$ req/min at $d = 0.2\text{ s}$ (60 req/min at
     $d = 0\text{ s}$).
   * Total across both lanes: **64 req/min** at $d = 0.2\text{ s}$ (**74 req/min** at
     $d = 0\text{ s}$), which is **3.2%–3.7%** of GitHub's 2,000 GraphQL pts/min secondary
     limit and **7.1%–8.2%** of the 900 REST pts/min limit.
   * Concurrency: strictly **<= 2** in-flight requests vs GitHub's 100 concurrent limit (2%).
   * Rate-limit pushback: any `*RateLimitError` on either lane immediately pauses both lanes
     and calls `s.allowance.exhaust(now)` under `s.mu`, emptying all 8 tokens.

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
