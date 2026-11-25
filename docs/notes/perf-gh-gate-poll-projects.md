# gh polling & RPC reductions: gate `PollProjects` and batch `GetBranchPullRequests`

Status: implemented on branch `perf/gh-gate-poll-projects`.

## What changed

1. **Gate `PollProjects` on active Pull Requests page interest (`proto/codefoundry/v1/gh.proto`, `internal/store/gh/{gh,store,activity,poll,poll_projects}.go`, `internal/api/gh_activity.go`, `gui/frontend/src/{api/gh,stores/gh,components/prs/PullRequestsPage}.ts*`)**:
   - Previously, `Store.applyPoll` called `s.pollProjects(ctx, cfg)` unconditionally on every 60s poll cycle even when the Pull Requests page was closed, doubling steady-state GitHub GraphQL search requests (`Poll` + `PollProjects`).
   - Added an interest lease on `gh.Store` (`Options.ProjectsWatch`, default `DefaultProjectsWatch = 10 * time.Minute`, mirroring `DefaultBranchWatch`) with `Store.WatchProjects()` (`projectsWatchedUntil`).
   - `applyPoll` now runs `pollProjects(ctx, cfg)` only while `projectsWatched(now)` is active (and still clears `Snapshot.Projects` when `github.dashboards_enabled` turns off or all tracked repositories are removed).
   - When `WatchProjects()` is called and `Snapshot.Projects.FetchedAt` is zero or older than `cfg.PollInterval` (with dashboards enabled, tracked repositories present, and the store not paused/unauthenticated), it queues a coalesced background `jobFunc` (`id: "poll_projects"`) so opening the Pull Requests page returns cached lists immediately without blocking `GetDashboard`, refreshes promptly off-band, and publishes `DashboardUpdated` (on change) plus `Polled` (updating `projects_fetched_at` / `projects_last_error`). When an initial startup poll is already due immediately, it lets that poll carry `pollProjects` instead of running a duplicate request.
   - Added backward-compatible `bool watch_projects = 2;` on `GetDashboardRequest`. `dashboardResource` keeps sending `watch_projects: false` for sidebar, composer, and background consumers; `PullRequestsPage` holds `watchProjects()` while mounted, which flips `dashboardResource` to `watch_projects: true`, triggers an immediate read on mount, and renews the 10-minute lease every 5 minutes (`PROJECTS_WATCH_KEEPALIVE_MS`).

2. **Batch `GetBranchPullRequests` RPC (`GetBranchesPullRequests`) (`proto/codefoundry/v1/gh.proto`, `internal/store/gh/{gh,activity}.go`, `internal/api/gh_activity.go`, `gui/frontend/src/{api/gh,stores/gh}.ts`, `gui/frontend/mock/{github,server}.ts`)**:
   - Previously, `ProjectsIndex.tsx` (`useOpenPullRequests`) watched `branchPullRequestsResource` for every non-default worktree branch across every project row, firing N separate `GetBranchPullRequests` unary RPCs on mount, on reconnect invalidation, and every 5 minutes.
   - Added `rpc GetBranchesPullRequests(GetBranchesPullRequestsRequest) returns (GetBranchesPullRequestsResponse)` (with `BranchPullRequestsQuery` / `BranchPullRequestsEntry`) while keeping single `GetBranchPullRequests` intact.
   - Added `Store.BranchesPullRequests(ctx, queries)` which validates all queries up front, deduplicates `(slug, head_ref)` pairs internally, reads memory/SQLite once per unique branch, renews all branch leases under a single mutex acquisition, triggers at most one `pollSoonLocked` / `nudge` wakeup for newly watched branches, and returns results in input order. `Store.BranchPullRequests` delegates to it.
   - Added microtask batching (`loadBranchPullRequests`) in `gui/frontend/src/stores/gh.ts` for `branchPullRequestsResource`: concurrent reads queued in the same microtask coalesce into one `GetBranchesPullRequests` RPC (deduplicating repeated keys), while single-branch reads keep using `GetBranchPullRequests`. Per-key `AbortSignal` cancellation rejects only the cancelled key and aborts the shared batch RPC only when every key in the batch has been cancelled.

## Prior behavior changes

- **`PollProjects` in Go store tests**: tests that assert on `PollProjects` execution (`poll_projects_test.go`, `yield_test.go`, and `TestPollDashboardsDisabled` in `poll_test.go`) now call `s.WatchProjects()` to declare Pull Requests page interest.
- **Unwatched background polls**: when no Pull Requests page is open (or after the 10-minute lease expires), `Snapshot.Projects` stays at its last cached snapshot until cleared (dashboards disabled / no tracked repos) or refreshed when `PullRequestsPage` re-mounts.

## Measurements

Measured with `internal/store/gh/perf_bench_test.go` (`TestPerfMeasurements/background_5_poll_cycles_unwatched`) and `gui/frontend/src/components/projects/ProjectsIndex.batch.test.tsx` against the merge base (before) and this branch (after):

| Metric | Before | After | Delta |
|---|---|---|---|
| 5 steady-state background poll cycles with Pull Requests page closed (2 tracked repos) — total GraphQL requests | `10` (`5 Poll` + `5 PollProjects`) | `5` (`5 Poll` + `0 PollProjects`) | `-50%` total GraphQL requests (`-100%` `PollProjects`) |
| `ProjectsIndex` mount with 16 non-default worktree branches across 4 GitHub projects — unary branch PR RPCs | `16` (`16 GetBranchPullRequests`) | `1` (`1 GetBranchesPullRequests`, batch size `16`) | `-93.75%` unary RPCs (`16 -> 1`) |
| Reconnect invalidation (`invalidateWatchedGhOnReconnect`) across 16 watched branches — unary branch PR RPCs | `16` (`16 GetBranchPullRequests`) | `1` (`1 GetBranchesPullRequests`, batch size `16`) | `-93.75%` unary RPCs (`16 -> 1`) |

## Verification

- `go test -race ./internal/store/gh/... ./internal/api/...` (including `TestPollProjectsGatingAndLease`, `TestBranchesPullRequestsBatch`, `TestPerfMeasurements/background_5_poll_cycles_unwatched`, and `TestGhDashboardProjectLists` / `TestGhRepoActivityAndBranch`).
- Frontend `typecheck`, `lint`, and Vitest (`PullRequestsPage.test.tsx`, `ProjectsIndex.test.tsx`, `ProjectsIndex.batch.test.tsx`, `gh.test.ts`, `ghBatch.test.ts`, `eventsReconnect.test.ts`, `mapping.test.ts`).
- Full `make check` + `make attest`.
