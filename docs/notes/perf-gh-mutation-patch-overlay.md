# gh store: in-place mutation patching, pre-flight skip, and generalized local overlay

Status: implemented on branch `perf/gh-mutation-patch-overlay`.

## What changed

1. **Skip redundant pre-flight `PullRequestFull` fetches using cached summaries and details (`pr_review.go`, `pr_draft.go`, `pr_close.go`, `pr_merge.go`, `pr_actions.go`)**:
   - `Store.nodeID` (`AddPullRequestComment`, `SubmitPullRequestReview`) checks in-memory `s.full`, then `s.summaries` (which already stores GitHub's GraphQL `PullRequest.ID` on every polled PR), before falling back to SQLite or `fetchFullJob`.
   - `SetPullRequestDraft` and `SetPullRequestClosed` reuse an eligible in-memory `s.full` entry (even when aged/stale) or a polled `s.summaries` entry without a pre-flight `PullRequestFull` round-trip. Whenever the cached copy would refuse (or lacks `ViewerCanClose`/`ViewerCanReopen` on a cached detail), `freshFor` still fetches fresh before refusing.
   - `SetPullRequestAutoMerge` reuses an eligible in-memory `s.full` entry (with matching head) or, when enabling on a cold detail panel, a non-partial polled `s.summaries` entry; GitHub enforces repository auto-merge rules and `expectedHeadOid`.
   - `MergePullRequest` skips the cold-detail `PullRequestFull` fetch when a non-partial polled `s.summaries` entry satisfies preconditions, `expectedHeadOid` (or fresh poll), and default-branch knowledge (for `DeleteBranch`). Stale/aged `s.full` entries keep their existing `currentFull` guard.
   - `RevertPullRequest` reuses a cached `PullRequestMerged` summary/detail (since `MERGED` is immutable on GitHub).
   - `SetPullRequestCheckbox` intentionally keeps its fresh `PullRequestBody` read (`freshBody`) so concurrent edits to the PR description are never overwritten.

2. **Direct in-place `s.full` patching from mutation responses (`queries/*.graphql`, `pr_detail.go`, `pr_detail_decode.go`, `pr_review.go`, `pr_draft.go`, `pr_close.go`, `pr_merge.go`, `pr_checkbox.go`, `pr_actions.go`)**:
   - Expanded mutation GraphQL return selections:
     - `add_comment.graphql`: `commentEdge { node { id author { ...ActorFields } body createdAt updatedAt url } }`
     - `add_pull_request_review.graphql`: `pullRequestReview { id url state body submittedAt author { ...ActorFields } commit { oid } pullRequest { reviewDecision updatedAt } }`
     - `mark_ready_for_review.graphql`, `convert_to_draft.graphql`: `pullRequest { isDraft updatedAt mergeStateStatus }`
     - `close_pull_request.graphql`, `reopen_pull_request.graphql`: `pullRequest { state closedAt updatedAt viewerCanClose viewerCanReopen }`
     - `enable_auto_merge.graphql`, `disable_auto_merge.graphql`: `pullRequest { autoMergeRequest { enabledAt mergeMethod } updatedAt }`
     - `merge_pull_request.graphql`: `pullRequest { merged state mergedAt mergedBy { login } mergeCommit { oid } updatedAt }`
     - `update_pull_request_body.graphql`: `pullRequest { id body updatedAt }`
     - `SetReviewRequest` (REST): decodes `requested_reviewers` (`login`, `avatar_url`, `type`), `requested_teams`, and `updated_at` from the existing REST response.
   - Added `fullCache.patch` and `Store.patchFull`: on mutation success (on the worker goroutine, so caller cancellation mid-flight still updates clients), patches a copy-on-write snapshot of `s.full` and clears `written` while **preserving** existing `stale`, `checksStale`, `confirmed`, `failure`, `FetchedAt`, and `PullRequest.UpdatedAt`. Current entries serve the patched copy in 0 ms with 0 blocking round-trips (and leaving `UpdatedAt` at fetch-time lets the next `pollSoon` poll reconcile any prior external edits); aged or poll-stale entries serve the patched copy immediately with `Refreshing: true` while reconciling in the background. `patchFull` also calls `s.moved.markWrite` (invalidating `Store.PullRequest()`), persists to SQLite, updates `s.summaries`, and publishes `PullRequestDetailUpdated`.
   - `gui/frontend/src/stores/prPanel.ts` is unchanged: its `invalidate` / `detailShows` call to `GetPullRequestDetail` now hits the already-patched `s.full` cache in 0 ms with 0 blocking GitHub round-trips. When a PR was not cached in `s.full` in memory, `patchFull` falls back to `invalidateFull`.

3. **Generalized `localOverlay` (`pr_merged_overlay.go`, `store.go`, `poll.go`, `poll_projects.go`, `activity.go`, `pr_watch.go`)**:
   - Generalized `mergedOverlay` into `localOverlay` supporting `merged`, `closed`, `reopened`, `draft`/`ready`, and `reviewDecision` local mutations with independent per-field confirmation and `mergeMarkTTL` (10m) bounds.
   - Overlays apply immediately to `Snapshot.Dashboard`, `Snapshot.Projects`, `BranchPullRequests` (via `applyBranch` on reads + `BranchPullRequestsUpdated` notifications), and `CachedPullRequest`/`CachedPullRequests`.
   - Poll diff baselines (`localOverlay.basis`, `localOverlay.projectsBasis`, and raw `s.branches`) remain strictly un-overlaid so `PullRequestChanged` and wake matching continue firing when GitHub's poll observes the state transition.

## Prior behavior changes

- **`TestAddPullRequestCommentRefetches`**: previously asserted `2` `PullRequestFull` fetches (initial load + post-comment refetch). Because `AddPullRequestComment` now patches `d.Comments` in place, the subsequent `FullPullRequest` read serves the new comment from cache with `1` `PullRequestFull` fetch total.
- **`TestSetPullRequestDraftCallerLeaves`**, **`TestMergePullRequestCallerLeaves`**, **`TestSetReviewRequestREST`**: previously asserted the cached `s.full` entry was marked `stale: true` after a successful mutation. They now assert the entry is patched in place with the new state/requests and remains fresh (`stale: false`) while still publishing `PullRequestDetailUpdated`.

## Measurements

Measured with `TestPerfMeasurements` in `internal/store/gh/perf_bench_test.go` using identical scenarios on `main` (before) and `perf/gh-mutation-patch-overlay` (after):

| Scenario | Before (GraphQL reqs / `PullRequestFull`) | After (GraphQL reqs / `PullRequestFull`) | Delta |
|---|---|---|---|
| Warm panel + `AddPullRequestComment` + `FullPullRequest` | `2` (`1` `PullRequestFull`) | `1` (`0` `PullRequestFull`) | `-50%` reqs, `0` refetches |
| Warm panel + `SubmitPullRequestReview` + `FullPullRequest` | `2` (`1` `PullRequestFull`) | `1` (`0` `PullRequestFull`) | `-50%` reqs, `0` refetches |
| Warm panel + `SetPullRequestDraft` + `FullPullRequest` | `2` (`1` `PullRequestFull`) | `1` (`0` `PullRequestFull`) | `-50%` reqs, `0` refetches |
| Warm panel + `SetPullRequestClosed` + `FullPullRequest` | `2` (`1` `PullRequestFull`) | `1` (`0` `PullRequestFull`) | `-50%` reqs, `0` refetches |
| Warm panel + `SetPullRequestAutoMerge` + `FullPullRequest` | `2` (`1` `PullRequestFull`) | `1` (`0` `PullRequestFull`) | `-50%` reqs, `0` refetches |
| Warm panel + `MergePullRequest` + `FullPullRequest` | `2` (`1` `PullRequestFull`) | `1` (`0` `PullRequestFull`) | `-50%` reqs, `0` refetches |
| Warm panel + `SetPullRequestCheckbox` + `FullPullRequest` | `3` (`1` `PullRequestFull`) | `2` (`0` `PullRequestFull`) | `-33%` reqs, `0` refetches (keeps fresh `PullRequestBody`) |
| Cold detail (polled summary) + `AddPullRequestComment` / `SubmitPullRequestReview` / `SetPullRequestDraft` / `SetPullRequestClosed` / `SetPullRequestAutoMerge` / `MergePullRequest` | `2` each (`1` pre-flight `PullRequestFull`) | `1` each (`0` `PullRequestFull`) | `-50%` reqs, `0` pre-flight |
| Aged panel + `SetPullRequestDraft` / `SetPullRequestClosed` / `SetPullRequestAutoMerge` + `FullPullRequest` | `3` each (`2` blocking `PullRequestFull`) | `2` each (`0` blocking `PullRequestFull`, `1` background refresh with instant patched display) | `-33%` reqs, `0` blocking refetches |
| Aged panel + `AddPullRequestComment` / `SubmitPullRequestReview` + `FullPullRequest` | `2` each (`1` blocking `PullRequestFull`) | `2` each (`0` blocking `PullRequestFull`, `1` background refresh with instant patched display) | `0` blocking refetches |

## Verification

- `go test -race -count=1 ./internal/store/gh/... ./internal/api/...`
- `make check` + `make attest`
