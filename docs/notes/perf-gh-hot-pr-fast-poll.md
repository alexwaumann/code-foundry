# gh store: foreground fast-poll for hot open pull requests

Status: implemented on branch `perf/gh-hot-pr-fast-poll` (PR C4).

Previously, an open pull request detail panel relied entirely on the regular 60 s
dashboard/repo poll (`Poll`) to discover CI progress (`PENDING` check count ticks,
`PENDING -> SUCCESS/FAILURE` completion) and GitHub's lazy `mergeable` / `mergeStateStatus`
computation (`UNKNOWN -> MERGEABLE/CONFLICTING`, which does not bump `updatedAt`). A user
watching CI finish or waiting for mergeability after a push or draft toggle waited 30 s on
average and up to 60 s worst-case.

Now the store runs a cheap, strictly foreground-gated `nodes(ids:)` fast-poll loop
(`PullRequestHot`, every 15 s) on the primary worker for **hot open pull requests** only.

## Architecture

### 1. Cheap `PullRequestHot` query (`internal/store/gh/queries/pull_request_hot.graphql`)

```graphql
query PullRequestHot($ids: [ID!]!) {
  rateLimit { ...RateLimitFields }
  nodes(ids: $ids) {
    __typename
    ... on PullRequest {
      ...PullRequestFingerprint
      isDraft
      mergeable
      mergeStateStatus
    }
  }
}
```

* Costs **1 GraphQL point** for up to `maxHotPRs = 8` PRs in a single `nodes(ids:)` request.
* Skips body, issue comments, commits, review lists, review threads, and individual check-run
  nodes.
* Unlike the search-based `Poll` fingerprint, it includes `isDraft`, `mergeable`, and
  `mergeStateStatus`, so lazy mergeability resolution (`UNKNOWN -> MERGEABLE/CONFLICTING`) is
  detected even when GitHub does not bump `updatedAt`.

### 2. Hot-PR lease & eligibility rules (`internal/store/gh/hot_poll.go`)

* `Store.hot` (`hotPRs`) holds a bounded map (`hotLeaseMax = fullCacheMax = 64`) of
  `fullKey -> hotLease{until, touchedAt, mutatedAt}`:
  * **`FullPullRequest`** renews a PR's lease (`DefaultHotLease = 5m`, preserving any
    existing `mutatedAt`), or drops it immediately if the PR is not open. The GUI re-reads
    an open panel every 60 s, so the lease never lapses while a panel is open: the lease
    only says someone is looking. What bounds the cost is the **quiet window**
    (`DefaultHotQuiet = 15m`, `lease.quietSince`): a PR is polled only while something
    changed within it. The window restarts when a hot poll sees the PR's state move
    (compared with the previous hot poll), a read returns a different state than the read
    before (compared with the previous read; never across the two sources, which can
    disagree), the PR is mutated here, or the lease is new (none, or the last one lapsed:
    a panel opened afresh). A keep-alive read returning the same state does not restart
    it. So a check that never reports or a mergeability stuck at `UNKNOWN` stops costing
    hot polls 15 minutes after its last change and is left to the regular 60 s poll
    (`docs/notes/fix-gh-hot-poll-lease-bound.md`).
  * **Local mutations** (`patchFull` / `invalidateFull`) refresh the lease AND stamp
    `mutatedAt = now` (for `DefaultHotMutateWindow = 2m`) so CI spinning up right after a
    ready-for-review toggle, reopen, checkbox edit, or comment is caught within 15 s even
    before `Checks.State` flips to `PENDING`. Mutations that close or merge a PR drop it
    from `Store.hot` immediately.
  * **Deleted / transferred PRs**: if a complete `PullRequestHot` response (no partial
    errors) omits an asked node ID (`null` node), its hot lease is dropped immediately.
* A leased PR is eligible for `PullRequestHot` **only** when **all** of the following hold:
  1. Its lease has not expired (`now < lease.until`) and it changed, was mutated or was
     leased afresh within `DefaultHotQuiet` (`now - lease.quietSince < 15m`).
  2. It has a cached entry in `Store.full` with non-empty node `ID`, `State == OPEN`, and
     neither `stale` nor `written` already set (if the entry is already marked stale, an
     open panel has not re-read yet and re-polling would waste requests).
  3. It is actively changing or waiting on GitHub computation:
     * `p.Checks.State == RollupPending`, **or**
     * `p.Mergeable == MergeableUnknown || p.MergeStateStatus == "UNKNOWN"`, **or**
     * `!lease.mutatedAt.IsZero() && now.Sub(lease.mutatedAt) < DefaultHotMutateWindow`.
* Each batch is capped at **`maxHotPRs = 8`** unique GraphQL node IDs, ordered **most
  recently touched first**.
* **Zero wasted polls**: when no PR is eligible (no panel open, settled open PRs with passing
  checks and known mergeability, closed/merged PRs, or expired leases), `next()` clears
  `hotNext` in foreground and schedules **0** `PullRequestHot` queries.

### 3. Strict foreground gating, pause safety & anti-duplication

* **Foreground only**: `next()` and `hotPoll()` require `s.presence() == PresenceForeground`.
  In `PresenceBackground` or `PresenceNone`, `jobHotPoll` is never scheduled or sent, while
  `hotNext` is preserved so `PresenceChanged` back to `PresenceForeground` nudges the worker
  and resumes promptly. Dropping from `PresenceForeground` while `hotNext` is armed nudges
  the worker once so any pending 15 s timer is replaced by `pollNext`.
* **Pause / auth / budget safety**: `jobHotPoll` runs only when `!s.authBad`, respects
  `s.pauseUntil`, and sends via `s.callMeta` (`admit` + `noteResult`). Rate limits, low
  remaining budget (`< MinRemaining`), auth failures, and network errors pause it identically
  to `jobPoll` and never override or clear a pause. Repeated non-global errors back off via
  `backoff(hotInterval, MaxBackoff, hotFailures, rand)`.
* **Cadence & anti-duplication**:
  * Configured via `Options.HotPollInterval` (default `DefaultHotPollInterval = 15s`;
    negative disables; floored by `MinGap` when positive so small test intervals work when
    `MinGap` is small).
  * `nextScheduledLocked` skips/defers `jobHotPoll` whenever a regular `jobPoll` is already
    due within `min(hotInterval/3, 3s)` of `max(hotAt, now)`.
  * When a regular `poll` finishes (`applyPoll`), `hotNext` is reset to `now + hotInterval`
    so a hot poll never fires immediately after a full poll.
  * On system wake (`sleepwake.go`), `onWake` schedules an immediate regular `poll`, which
    automatically supersedes `jobHotPoll` via the anti-duplication window and resets
    `hotNext` afterward.

### 4. Applying results & dashboard reconciliation

* `applyHotPoll` runs unbroken after `s.callMeta` returns:
  * Updates `s.summaries.putFingerprints` with the live fingerprints observed at `hotStart`.
  * Drops any PR whose returned `State != OPEN` from `s.hot` immediately.
  * Calls `s.full.applyHotAt(nodes, fpSeq, now)`:
    * **Unchanged** (same fingerprint + `Draft` + `Mergeable` + `MergeStateStatus`): updates
      `e.confirmed = now` when confirmable; emits **0** events and **0** refetches.
    * **Pending check counts only** (`pendingCheckCountsOnly` and `Draft`/`Mergeable`/
      `MergeStateStatus` unchanged): patches `e.d.PullRequest.Checks` in place, sets
      `e.checksStale = true`, updates `s.summaries`, marks `s.moved`, and publishes
      `PullRequestDetailUpdated` so the open panel refreshes **only** `checks.graphql`
      (0 `PullRequestFull`).
    * **Anything else moved** (checks settled `PENDING -> SUCCESS/FAILURE`, check failed,
      `Mergeable` / `MergeStateStatus` resolved, `Draft` flipped, `State` closed/merged,
      `HeadSHA` or `UpdatedAt` advanced): sets `e.stale = true`, records `movedSeq[k] = fpSeq`,
      invalidates `s.reviewers`, marks `s.moved` (for both canonical and local repo slugs so
      `Store.PullRequest` / `pr.checks` facts refresh), and publishes
      `PullRequestDetailUpdated`.
* **Dashboard reconciliation**: `PullRequestHot` deliberately does **not** mutate
  `Snapshot().Dashboard` or trigger an extra full `Poll` on every transition — the open
  detail panel and `Store.PullRequest` update immediately with 0 extra search polls, and the
  regular 60 s `Poll` reconciles dashboard lists and `PullRequestChanged` without duplicating
  `applyPoll`'s diffing logic.

## Concurrency, scheduling & causality audit

| Invariant | How it is preserved |
|---|---|
| **Lock hierarchy** | `Store.hot.mu`, `Store.full.mu`, and `Store.mu` are strictly **leaf locks** — never nested. `next()` and `hotPoll()` snapshot active leases under `hot.mu`, evaluate eligibility under `full.mu`, drop closed keys under `hot.mu`, and only then lock `Store.mu`. |
| **Yielding (`yield.go`)** | `execute()` sets `s.scheduled = true` for `jobHotPoll`, so `admit()` yields to user-waited clicks before sending and watches `s.wake` during `MinGap`. `maxJobsAhead` starvation protection applies identically to `jobPoll`. |
| **Read lane (`read_lane.go`)** | `readLaneEligible()` and `dedupInflight()` exclude `jobHotPoll`. `jobHotPoll` never spends `gapAllowance` tokens. Because `PullRequestHot` is a read-only primary request, `callDocMeta` calls `beginPrimaryRead()`, allowing a user-waited click to overlap on the read lane while `PullRequestHot` is in flight. |
| **Causality (`fpSeq` vs `fetchSeq`)** | `applyHotAt` mirrors `applyPollAt` (PR #907): entries with `e.fetchSeq > fpSeq` and strictly newer `UpdatedAt` are left untouched; equal `UpdatedAt` only advances on resolved `UNKNOWN` mergeability or differing check rollups (never regressing a newer resolved entry back to `UNKNOWN`); moving nodes record `c.movedSeq[k] = fpSeq` so late older-seq responses land as `stale: true`. |

## GraphQL budget math

* **Idle / background / no-GUI / settled PRs**: **0 req/hr** (0 points/hr).
* **Active foreground hot PRs** (`PollInterval = 60s`, `HotPollInterval = 15s`, skip window `3s`):
  * On a healthy 60 s poll cadence, `applyPoll` resets `hotNext = t + 15s`, yielding at most
    **3** `PullRequestHot` queries per 60 s cycle (at `+15s`, `+30s`, `+45s`; the `+60s`
    slot is suppressed by the 3 s anti-duplication window in favor of the regular `Poll`),
    or **180 `PullRequestHot` pts/hr**.
  * If `PollInterval` is longer than 60 s or the regular poll is backing off, the true
    `PullRequestHot` ceiling is **4 req/min = 240 pts/hr** (4.8% of GitHub's 5,000 pts/hr
    primary budget; 0.20% of the 2,000 pts/min secondary limit), regardless of whether 1 or
    8 PRs are hot (cost is 1 point per batch).
  * Including induced panel refreshes (`checks.graphql` or `PullRequestFull`, up to 1 per
    detected hot-poll change per open panel), a realistic sustained worst case with
    continuously changing CI in the foreground for a full hour is roughly
    `60 (Poll) + 240 (PullRequestHot) + 240 (induced refreshes) ≈ 540 pts/hr` (~10.8% of
    GitHub's 5,000 pts/hr primary budget), paused at `MinRemaining = 200`.
  * A PR whose state never resolves (a required status that never reports, mergeability
    stuck at `UNKNOWN`) costs at most `DefaultHotQuiet / HotPollInterval = 60` hot polls
    (59 when its open arms the timer, about 45 on a healthy 60 s regular poll; calculated,
    not measured) after its last change, mutation or fresh
    open, then none, however long its panel stays open. The same holds for all 8 slots
    together, since one request carries them all: hot polling stops 15 minutes after the
    last restart of any of their windows. Only a stream of real changes or user actions
    (opening, hovering into a prefetch, or mutating PRs) keeps it at the 4 req/min
    ceiling.
* **Runaway ceiling**: because `jobHotPoll` runs on the primary worker at `MinGap` (1 s) and
  never spends `gapAllowance` tokens, the global runaway bound in
  `docs/notes/perf-gh-read-lane.md` is strictly unchanged by it. That bound was
  corrected on 2026-11-27 from 3,368 to **<= 4,840 GraphQL req/hr** at 0.2 s RTT. The
  `MinRemaining = 200` pause is what guarantees the budget.

## Real measurements (2026-11-25, Apple M3 Pro, darwin/arm64)

### 1. Detection latency harness (before vs after)

Measured via `go test -run '^$' -bench 'BenchmarkHotPollDetectionLatency' -benchtime=5x -count=1 ./internal/store/gh`
(`perf_bench_test.go`), 100x time-scaled (`PollInterval = 600ms` ≡ `60s`,
`HotPollInterval = 150ms` ≡ `15s`, transition occurring `50ms` ≡ `5s` after a regular poll):

| Scenario (`n = 5`, flip at +5 s after poll) | Before (`HotPollInterval: -1`) | After (`HotPollInterval: 15 s`) | Improvement |
|---|---|---|---|
| CI settles `PENDING -> SUCCESS` | `549.6 ms` (≡ **55.0 s**), `1` `Poll`, `0` `PullRequestHot` | **`98.6 ms`** (≡ **9.9 s**), `0` `Poll`, `1` `PullRequestHot` | **5.6x faster** (-82.1%) |
| `MergeableUnknown -> MERGEABLE` (no `UpdatedAt` bump) | `563.4 ms` (≡ **56.3 s**), `1` `Poll`, `0` `PullRequestHot` | **`99.8 ms`** (≡ **10.0 s**), `0` `Poll`, `1` `PullRequestHot` | **5.6x faster** (-82.3%) |
| Analytical uniform transition in `[0, 60 s)` | **30.0 s** avg / **60.0 s** max | **7.5 s** avg / **15.0 s** max | **4.0x faster** avg & worst-case |

### 2. Live read-only GitHub measurement (`alexwaumann/code-foundry`)

Measured via `GH_LIVE_MEASURE=1 go test -v -run '^TestHotPollLiveMeasurement$' -count=1 ./internal/store/gh`
against live `api.github.com` over HTTP/2:

| Query | RTT | Payload bytes | GraphQL cost | Relative to full `Poll` |
|---|---:|---:|---:|---|
| `PullRequestHot` (1 PR) | **301 ms** | **1,207 B** | **1** | **9.4x faster**, **18.0x smaller** |
| `PullRequestHot` (5 PRs) | **449 ms** | **5,647 B** | **1** | **6.3x faster**, **3.8x smaller** |
| Full `Poll` (dashboards + 1 tracked repo) | 2,837 ms | 21,728 B | 1 | baseline |

### 3. Idle / settled / background overhead

Verified under `-race` in `internal/store/gh/hot_poll_test.go`:
* **0** `PullRequestHot` queries with no panel open, settled open PRs, closed/merged PRs,
  expired leases, or `PresenceBackground` / `PresenceNone`.

## Verification

* `internal/store/gh/hot_poll_test.go`:
  * `TestHotPollPendingCITransitions` (`PENDING` count tick → `checksStale` + `checks.graphql`
    only; `PENDING -> SUCCESS` → `stale` + `s.moved` + 0 further hot polls once settled).
  * `TestHotPollMergeableResolution` (`MergeableUnknown -> MERGEABLE` without `UpdatedAt`
    bump detected and marked stale).
  * `TestHotPollPostMutationWindow` (`SetPullRequestDraft` / `patchFull` keeps PR hot for
    `DefaultHotMutateWindow` and stops after expiry).
  * `TestHotPollZeroWastedPolls` (no panel open, settled open PR, closed/merged PR dropped
    immediately, expired lease, negative `HotPollInterval`).
  * `TestHotPollPresenceGating` (0 hot polls in `PresenceBackground` / `PresenceNone`,
    prompt resume on `PresenceChanged` to `PresenceForeground`, clean stop on drop).
  * `TestHotPollPauseAuthAndBudget` (rate limit, auth failure, low remaining budget).
  * `TestHotPollAntiDuplication` (skips when full poll is imminent within `min(hot/3, 3s)`,
    resets `hotNext` after regular poll completes).
  * `TestHotPollCapMaxHotPRs` (12 eligible PRs capped to 8 most recently touched IDs).
  * `TestHotPollReadLaneCausalityAndYielding` (concurrent read-lane overlap + `fetchSeq > fpSeq`
    causality, single-lane yielding, 0 `gapAllowance` tokens spent, `readLaneEligible() == false`).
  * `TestDecodeHotNodesIgnoresNullAndNonPullRequest` (cleanly skips deleted/non-PR union nodes).
* `internal/store/gh/hot_poll_quiet_test.go`:
  * `TestHotPollNeverResolvingPRIsBounded` (panel re-read every 60 s for 2 h on a PR stuck
    `PENDING`: exactly `DefaultHotQuiet / HotPollInterval - 1 = 59` hot polls; 480 before the fix).
  * `TestHotPollQuietRearm` (keep-alive reads do not re-arm; a mutation, a fresh open after
    the lease lapsed, and a read returning a change do).
  * `TestHotPollProgressingCIStaysHot` (a check finishing every 14 minutes keeps the PR hot
    for the whole run, and the run's end is seen by the next hot poll).
