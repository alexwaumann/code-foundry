# gh store: cache unification, SQLite hydration validation, pending check-count patch, reviewer cache, and typed equality

Status: implemented on branch `perf/gh-cache-unify-and-check-counts`.

## What changed

1. **Unified in-memory PR summary & detail cache (`pr_cache.go`, `store.go`, `poll.go`, `poll_projects.go`, `pr_detail.go`, `pr_watch.go`, `activity.go`, `pr_merged_overlay.go`)**:
   - Added `prSummaryCache` (`Store.summaries`), a bounded LRU (`summaryCacheMax = 1024`) canonical `slug#number -> PullRequest` index updated whenever `Snapshot.Dashboard`, `Snapshot.Projects`, `s.branches`, `PullRequest` (`GetPullRequest`), or `FullPullRequest` (`s.full`) updates a pull request (including renamed repositories via `Snapshot.LocalRepo`).
   - Added `detailCache` (`Store.prDetails`, bounded LRU `detailCacheMax = 64`). `Store.PullRequest` checks `s.prDetails` and non-stale `s.full` entries in memory before falling back to SQLite (`gh_pull_request_details`), and populates `s.prDetails` + `s.summaries` on SQLite load and on `fetchPullRequest`. `LookupPullRequest` continues to bypass every cache and query GitHub directly, while populating `s.prDetails` and `s.summaries` with its fresh answer.
   - `resolveWatchedHeads` checks `s.summaries` before hitting SQLite or GitHub.
   - `CachedPullRequest` / `CachedPullRequests` retain their isolation from `Snapshot.Projects` (still scoped to dashboards and branches).

2. **Fingerprint-validated SQLite hydration for `FullPullRequest` (`pr_detail.go`, `pr_cache.go`, `detail_moved.go`)**:
   - Previously, `cachedFull` called `s.full.adopt` and marked every SQLite-loaded `FullPullRequest` as `stale: true` unconditionally, forcing a background `PullRequestFull` GraphQL refetch even when a live poll had already confirmed the pull request unchanged.
   - Now `prSummaryCache` tracks live-poll summaries separately (`polledAt > 0`, never set by startup SQLite loads). When `cachedFull` loads a row from SQLite, if a live poll at `polledAt >= row.FetchedAt` confirmed every tracked field (`ID`, `UpdatedAt`, `HeadSHA`, `State`, `Draft`, `Checks`, and for open pull requests `ReviewDecision`, `Comments`, `Reviews`, `Mergeable`, `MergeStateStatus`, with `!Partial`), `confirmable(row)` holds, and neither a poll move nor a local write (`invalidateFull` -> `movedDetails.markWrite`) invalidated it since `row.FetchedAt`, `cachedFull` adopts it with `stale: false, confirmed: polledAt` (`adoptConfirmed`), skipping the redundant GraphQL fetch. Existing `confirmedMaxAge` (10 min) and `confirmWindow` rules in `fullEntry.serves` still apply.

3. **In-place check-count patch while CI runs (`pr_detail.go`, `detail_moved.go`)**:
   - Previously, `fullCache.applyPoll` and `markMovedDetails` treated every `p.Checks != f.Checks` difference as stale, triggering a full `PullRequestFull` GraphQL refetch on every poll tick while CI checks progressed.
   - Added `pendingCheckCountsOnly(p, f)`: when `UpdatedAt`, `State`, and `HeadSHA` are unchanged, both old and new rollups stay `PENDING` (`f.Checks.Pending > 0`), and `f.Checks.Failed == p.Checks.Failed` (no new failure), `fullCache.applyPoll` patches `e.d.PullRequest.Checks = f.Checks` in place, updates `e.confirmed = now` (if `confirmable`), keeps `e.stale = false`, and emits `PullRequestDetailUpdated` so open panels update counts immediately without refetching. `markMovedDetails` likewise patches `s.prDetails` in place without marking `s.moved`.
   - When CI settles (`SUCCESS`/`FAILURE`/`ERROR`), a check newly fails (`Failed` increases), CI starts from a non-pending state, or any non-check field moves, the entry goes stale and refetches as before so individual `CheckRun` rows stay accurate.

4. **Cached repository assignable users for `ReviewerCandidates` (`queries/reviewer_candidates.graphql`, `reviewer_search.go`, `pr_detail_decode.go`, `pr_actions.go`)**:
   - Added `$all: Boolean!` and `allAssignable: assignableUsers(first: 100) @include(if: $all) { pageInfo { hasNextPage } nodes { id login name avatarUrl } }` to `reviewer_candidates.graphql`.
   - Added `reviewerCache` (`Store.reviewers`): bounded LRU cache (`assignableCacheMax = 64`, `assignableCacheTTL = 10m`) per repository `slug` plus per-PR `(author, requested)` cache (`prReviewersCacheMax = 64`, `prReviewersCacheTTL = 2m`, invalidated on `invalidateFull` and stale poll moves).
   - When a repository fits in one page (`!hasNextPage`), subsequent non-empty search keystrokes filter locally via `localReviewerCandidates` with 0 GitHub requests. For large repositories (`hasNextPage == true`), the cache records `truncated: true` and falls back cleanly to the existing GraphQL search query. Opening the picker (`query == ""`) always fetches fresh pending review requests (and warms the repo assignable cache if cold).

5. **Direct typed equality replacing hot-path `sameJSON` (`equal.go`, `poll.go`, `poll_projects.go`, `pr_detail.go`)**:
   - Replaced `sameDashboard` (which previously double-marshaled via `sameJSON(a, b) && sameJSON(a.Stats, b.Stats)`), `sameStats`, `sameBranchCI`, `sameProjects`, `sameFull`, and the branch list comparison in `poll.go` with zero-allocation typed equality helpers in `equal.go`, preserving exact nil-vs-empty slice and `time.Time.Equal` semantics.

## Prior behavior changes

- **`TestReviewerCandidatesSeveralWords`**: previously asserted 3 `ReviewerCandidates` GraphQL requests for 3 multi-word queries against the same 4-user repository. Because the first query now caches the repository's complete assignable user list (`!hasNextPage`), the subsequent 2 queries are served locally with 0 GitHub requests (1 request total instead of 3).
- **Pending CI check-count ticks on open PR panels**: while CI remains `PENDING` with no new failures and no non-check field changes, `FullPullRequest` now updates summary `PullRequest.Checks` counts in place instead of refetching individual `CheckRun` rows on every poll; individual `CheckRun` rows still refresh as soon as any check fails, CI finishes, or any non-check field moves (and at `confirmedMaxAge`).

## Measurements (darwin/arm64, Apple M3 Pro)

Measured with `internal/store/gh/perf_bench_test.go` using the exact same tests and benchmarks before any production edits and after implementation:

| Metric | Before | After | Delta |
|---|---|---|---|
| SQLite-hydrated `FullPullRequest` on unchanged PR (after live poll confirms) | `1` GraphQL `PullRequestFull`, `refreshing=true` | `0` GraphQL `PullRequestFull`, `refreshing=false` | `-100%` requests |
| Open PR detail across 5 polling ticks of in-progress CI (`PENDING`, 1/12 → 6/12 passed) | `5` GraphQL `PullRequestFull` refetches | `0` GraphQL `PullRequestFull` refetches (counts patched live to 6/12) | `-100%` requests |
| `GetPullRequest` (`PullRequest`) cache hit — 200 calls (`TestPerfMeasurements`) | `200` SQLite queries (`1/call`), `39.65µs/call` | `0` SQLite queries (`0/call`), `328ns/call` | `0` SQLite queries, `~121x` faster |
| `BenchmarkPullRequestCacheHit` (median of 3 runs, `-benchmem`) | `15,207 ns/op`, `1.000 sqlite_queries/op`, `3,412 B/op`, `53 allocs/op` | `280.5 ns/op`, `0 sqlite_queries/op`, `0 B/op`, `0 allocs/op` | `~54x` faster, `0` allocs, `0` SQLite |
| `ReviewerCandidates` 6 keystrokes on cached repo (`MinGap=20ms`, `UserGap=5ms`) | `6` GraphQL calls, `36.866ms` total (`6.144ms/query`) | `0` GraphQL calls, `18.625µs` total (`3.104µs/query`) | `-100%` requests, `~1980x` faster |
| `BenchmarkSameDashboard` (70 PRs + 6-month stats, median of 3 runs, `-benchmem`) | `222,289 ns/op`, `175,529 B/op`, `1,172 allocs/op` | `5,187 ns/op`, `0 B/op`, `0 allocs/op` | `~43x` faster, `0` allocs |

## Verification

- `go test -race ./internal/store/gh/...` (including new `pr_cache_test.go`, `equal_test.go`, and `perf_bench_test.go`).
- Full `make check`.
