# gh store: cache unification, SQLite hydration validation, lightweight CI checks refresh, reviewer cache, and typed equality

Status: implemented on branch `perf/gh-cache-unify-and-check-counts`.

## What changed

1. **Unified in-memory PR summary & detail cache (`pr_cache.go`, `store.go`, `poll.go`, `poll_projects.go`, `pr_detail.go`, `pr_watch.go`, `activity.go`, `pr_merged_overlay.go`)**:
   - Added `prSummaryCache` (`Store.summaries`, bounded LRU `summaryCacheMax = 1024`) indexing `slug#number -> PullRequest` summaries plus live-poll fingerprints (`polledFP`, `polledAt`), including renamed repositories via `Snapshot.LocalRepo`.
   - Added `detailCache` (`Store.prDetails`, bounded LRU `detailCacheMax = 64`). `Store.PullRequest` checks `s.prDetails` and non-stale, non-truncated `s.full` entries in memory before falling back to SQLite (`gh_pull_request_details`), and populates `s.prDetails` + `s.summaries` on SQLite load and on `fetchPullRequest`. `LookupPullRequest` continues to bypass caches and query GitHub directly while populating memory with its fresh answer.
   - `resolveWatchedHeads` checks `s.summaries` before hitting SQLite or GitHub.
   - `CachedPullRequest` / `CachedPullRequests` retain their isolation from `Snapshot.Projects` (still scoped to dashboards and branches).

2. **Fingerprint-validated SQLite hydration for `FullPullRequest` (`pr_detail.go`, `pr_cache.go`, `poll.go`, `poll_projects.go`, `detail_moved.go`)**:
   - Previously, `cachedFull` marked every SQLite-loaded `FullPullRequest` as `stale: true` unconditionally, forcing a background `PullRequestFull` GraphQL refetch even when a live poll had already confirmed the pull request unchanged.
   - Now `poll.go` and `poll_projects.go` record live `[]prFingerprint` entries directly from GitHub via `s.summaries.putFingerprints` (never carried-over copies from failed detail batches). When `cachedFull` loads a row from SQLite, if a live poll at `polledAt >= row.FetchedAt` produced a matching fingerprint (`ID`, `UpdatedAt`, `State`, `HeadSHA`, and `Checks` for open PRs — the exact same invariant `applyPoll` uses to confirm an in-memory entry), `confirmable(row)` holds, and neither a poll move nor a local write (`invalidateFull` -> `movedDetails.markWrite`) invalidated it since `row.FetchedAt`, `cachedFull` adopts it with `stale: false, confirmed: polledAt` (`adoptConfirmed`), skipping the redundant GraphQL fetch. Existing `confirmedMaxAge` (10 min) and `confirmWindow` rules in `fullEntry.serves` still apply.

3. **Lightweight `checks.graphql` refresh on pending CI count ticks (`pr_detail.go`)**:
   - Previously, `fullCache.applyPoll` marked an open PR panel fully `stale: true` on every poll tick while CI checks progressed, refetching the entire `pull_request_full.graphql` document (comments, commits, reviews, review threads, and checks) each minute.
   - Added `fullEntry.checksStale` + `pendingCheckCountsOnly(p, f)`: when `UpdatedAt`, `State`, and `HeadSHA` are unchanged, both old and new rollups stay `PENDING` (`f.Checks.Pending > 0`), and `f.Checks.Failed == p.Checks.Failed` (no new failure), `applyPoll` patches `e.d.PullRequest.Checks = f.Checks` immediately (so header counts update at once) and sets `e.checksStale = true` (leaving `e.stale = false`).
   - If an open panel re-reads `FullPullRequest`, `staleFirst` immediately returns the patched header counts and queues `fetchChecksOnly` (`checks.graphql` on `HeadSHA`) instead of `pull_request_full.graphql`, keeping individual `CheckRun` rows accurate in `ReadinessBox` and `PrChecks` without re-fetching comments, commits, reviews, or review threads. If `checks.graphql` returns `ErrNotFound` (e.g., force-push before the next poll), it falls back to `fetchFull`. Explicit refreshes (`refresh=true`), post-write reads, settled checks, new failures, or any non-check move run `fetchFull` as before.
   - `markMovedDetails` continues marking `s.moved` on every `fingerprintMoved` so `PullRequest()` (backing plugin `pr.checks` facts) never serves stale check-run rows.

4. **Cached repository assignable users for `ReviewerCandidates` (`queries/reviewer_candidates.graphql`, `reviewer_search.go`, `pr_detail_decode.go`, `pr_actions.go`)**:
   - Added `$all: Boolean!` and `allAssignable: assignableUsers(first: 100) @include(if: $all) { pageInfo { hasNextPage } nodes { id login name avatarUrl } }` to `reviewer_candidates.graphql`.
   - Added `reviewerCache` (`Store.reviewers`): bounded LRU cache (`assignableCacheMax = 64`, `assignableCacheTTL = 10m`) per repository `slug` plus per-PR `(author, requested)` cache (`prReviewersCacheMax = 64`, `prReviewersCacheTTL = 2m`, guarded by a per-key generation counter so an in-flight read cannot overwrite a newer `SetReviewRequest` invalidation).
   - When a repository fits in one page (`!hasNextPage`), subsequent non-empty search keystrokes filter locally via `localReviewerCandidates` with 0 GitHub requests. Large repositories (`hasNextPage == true`) record `truncated: true` and fall back to the GraphQL search query. Opening the picker (`query == ""`) always fetches fresh pending review requests (and warms the repo assignable cache if cold).

5. **Direct typed equality replacing hot-path `sameJSON` (`equal.go`, `equal_test.go`, `poll.go`, `poll_projects.go`, `pr_detail.go`)**:
   - Replaced `sameDashboard` (which previously double-marshaled via `sameJSON(a, b) && sameJSON(a.Stats, b.Stats)`), `sameStats`, `sameBranchCI`, `sameProjects`, `sameFull`, and the branch list comparison in `poll.go` with zero-allocation typed equality helpers in `equal.go`, preserving nil-vs-empty slice and `time.Time.Equal` semantics.
   - Added a reflection guard (`TestTypedEqualityCoversAllFields` in `equal_test.go`) that mutates every exported field on every covered struct so new fields cannot be silently ignored.

## Prior behavior changes

- **`TestReviewerCandidatesSeveralWords`**: previously asserted 3 `ReviewerCandidates` GraphQL requests for 3 multi-word queries against the same 4-user repository. Because the first query now caches the repository's complete assignable user list (`!hasNextPage`), the subsequent 2 queries are served locally with 0 GitHub requests (1 request total instead of 3).
- **Pending CI check-count ticks on open PR panels**: while CI remains `PENDING` with no new failures and no non-check field changes, background detail refreshes now query `checks.graphql` (check runs + rollup only) instead of the full `pull_request_full.graphql` document, keeping both header counts and individual `CheckRun` rows live.

## Measurements (darwin/arm64, Apple M3 Pro)

Measured with `internal/store/gh/perf_bench_test.go` using the exact same tests and benchmarks against the merge base (before) and this branch (after):

| Metric | Before | After | Delta |
|---|---|---|---|
| SQLite-hydrated `FullPullRequest` on unchanged PR (after live poll confirms) | `1` GraphQL `PullRequestFull`, `refreshing=true` | `0` GraphQL `PullRequestFull`, `refreshing=false` | `-100%` requests |
| Open PR detail across 5 polling ticks of in-progress CI (`PENDING`, 1/12 → 6/12 passed) | `5` `PullRequestFull` refetches | `0` `PullRequestFull` refetches (`5` lightweight `Checks` queries keeping check rows live) | `0` heavy detail refetches |
| `GetPullRequest` (`PullRequest`) cache hit — 200 calls (`TestPerfMeasurements`) | `200` SQLite queries (`1/call`), `39.65µs/call` | `0` SQLite queries (`0/call`), `328ns/call` | `0` SQLite queries, `~121x` faster |
| `BenchmarkPullRequestCacheHit` (`-benchmem`) | `15,207 ns/op`, `1.000 sqlite_queries/op`, `3,412 B/op`, `53 allocs/op` | `280.5 ns/op`, `0 sqlite_queries/op`, `0 B/op`, `0 allocs/op` | `~54x` faster, `0` allocs, `0` SQLite |
| `ReviewerCandidates` 6 keystrokes on cached repo | `6` GraphQL calls | `0` GraphQL calls (`~3µs/query` local filter) | `-100%` GraphQL requests |
| `BenchmarkSameDashboard` (70 PRs + 6-month stats, `-benchmem`) | `222,289 ns/op`, `175,529 B/op`, `1,172 allocs/op` | `5,187 ns/op`, `0 B/op`, `0 allocs/op` | `~43x` faster, `0` allocs |

## Verification

- `go test -race ./internal/store/gh/...` (including `pr_cache_test.go`, reflection guard `TestTypedEqualityCoversAllFields` in `equal_test.go`, and `perf_bench_test.go`).
- Full `make check` + `make attest`.
