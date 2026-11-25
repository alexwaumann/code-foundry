# GUI reconnect `since_seq`, PR event cache patching, and diff/refs LRU caches

Six targeted latency and RPC-reduction improvements across the event stream, GitHub stores, thread info card, and diff/refs views.

## Changes

1. **Reconnect `since_seq` / `since_epoch` + gh reconnect invalidations** (`gui/frontend/src/api/events.ts`, `gui/frontend/src/stores/events.ts`, `gui/frontend/src/stores/gh.ts`, `internal/api/events.go`)
   - `watchEvents` now accepts optional `{ sinceSeq, sinceEpoch, onEnvelope }` and forwards `sinceSeq` / `sinceEpoch` on `EventService.Watch`.
   - `startEventSync` tracks the highest received `(seq, epoch)` across reconnects so brief network or sleep blips replay only missed events from the daemon's 4096-event hub ring instead of re-streaming every source snapshot.
   - When a GUI client resumes at the head (`since_seq == lastSeq`, 0 missed events), `EventService.Watch` sends an immediate `StreamHeartbeat` stamped with the daemon's `epoch` so the client marks the stream open immediately instead of waiting for `HeartbeatInterval`.
   - When a reconnect cannot resume (daemon restart with new `epoch` or hub log wrapped) and falls back to snapshots (`seq === 0n`), `startEventSync` resets `lastSeq`, reloads the settings schema on epoch change, reconciles removed terminals from the snapshot burst (which always precedes `threadList` snapshot), and calls `invalidateWatchedGhOnReconnect()` once per `gh` snapshot burst so currently watched `branchPullRequestsResource` and `pullRequestDetailResource` keys refresh immediately rather than staying stale for 60 s–5 min.

2. **Remove redundant connect List RPCs** (`gui/frontend/src/stores/events.ts`)
   - Removed the parallel `listProjects`, `listTerminals`, and `reconcileThreads` RPCs from `startEventSync`'s `onConnect`, since `EventService.Watch` already streams `ProjectSnapshot`, `WorkspaceSnapshot`, `TerminalUpdated`*, and `ThreadListSnapshot` immediately on fresh connect.
   - Marked `useProjectsStore` loaded on `project` snapshot, `useTerminalsStore` loaded on `terminal` events and on `threadList` snapshot (covering the zero-terminal case).

3. **In-place frontend cache patching from `pull_request_changed`** (`gui/frontend/src/api/gh.ts`, `gui/frontend/src/stores/gh.ts`)
   - Mapped `GhEvent.pullRequestChanged` in `toGhEventView` (previously returned `null`).
   - Added `patchPullRequestInCaches` in `applyGhEvent` to update matching PR rows in-place across `dashboardResource` (`authored`, `reviewRequested`, `reviewed`, `recentlyMerged`, `projectOpen`, `projectMerged`), `branchPullRequestsResource`, and `pullRequestDetailResource` (updating `entry.data.pullRequest` while keeping `body`, `comments`, `commits`, and `reviews` intact) with zero extra RPCs and without superseding any in-flight refresh.

4. **Bounded LRU cache for parsed `PrDiffView` models** (`gui/frontend/src/components/pr/diffModel.ts`, `gui/frontend/src/components/diff/PrDiffView.tsx`)
   - Added `cachedParsePrDiff(prKey, diff, headSha)` backed by a 16-entry module-level LRU `Map` keyed by `(prKey, headSha)` and verified against `diff` equality.
   - Switching tabs back to a PR diff or receiving an unchanged diff re-read returns the already-parsed `PrDiffModel` without calling `parsePatchFiles` again.

5. **Cache-first linked PR display in `GitGroup.tsx`** (`gui/frontend/src/components/sidebar/useLinkedPrs.ts`, `gui/frontend/src/components/threadinfo/GitGroup.tsx`)
   - Extended summary lookup (`useSummaryPrViews`) to include `dashboardResource` (`authored`, `reviewRequested`, `reviewed`, `recentlyMerged`, `projectOpen`, `projectMerged`) and `branchPullRequestsResource`.
   - `GitGroup.tsx` now watches `pullRequestDetailResource` (heavy full-detail GraphQL query with 60 s keep-alive) only for linked PRs absent from those summary caches.

6. **Bounded LRU caches for Diff tab & `SourcePicker` reads** (`gui/frontend/src/components/files/useTabRead.ts`, `gui/frontend/src/components/diff/diffCaches.ts`, `gui/frontend/src/components/diff/DiffView.tsx`, `gui/frontend/src/components/diff/DiffFile.tsx`, `gui/frontend/src/components/diff/SourcePicker.tsx`)
   - Added `createTabReadCache` (bounded LRU with `peek`, `get`, `set`, `invalidate`, `clear`) and optional `{ cache, mode: "revalidate" | "fresh" }` to `useTabRead`.
   - `DiffFile` uses a 32-entry `mode: "fresh"` cache so toggling between files in a Diff tab serves revisited files immediately with zero extra `GetWorktreeCompareFile` RPCs until invalidated by worktree/status/file/index changes or manual Refresh.
   - `DiffView` (`CompareWorktree` / `ListCompareCommits`) uses 24-entry caches (`mode: "fresh"` for immutable commit views, `mode: "revalidate"` for live comparisons) invalidated on worktree changes and Refresh; `SourcePicker` uses a 32-entry `mode: "revalidate"` cache so cached refs appear immediately on reopen while refreshing in the background.

## Measurements (before vs after)

Measured with the same Vitest harnesses before any edits and after all edits (plus isolated `parsePrDiff` vs `cachedParsePrDiff` timing on a 919 KB / 100-file diff under Bun):

| Metric | Before | After |
|---|---|---|
| Fresh connect unary list RPCs (`listProjects` + `listTerminals` + `listThreads`) | 3 (6 after 1 reconnect) | **0** (**0** after 1 reconnect) |
| Reconnect after blip (`seq=2, epoch="ep-1"`) | `sinceSeq=0`, 3 snapshots, 0 replayed | `sinceSeq=2, sinceEpoch="ep-1"`, **0 snapshots**, **1 incremental replay** |
| `pull_request_changed` cache propagation (dashboard authored, projectOpen, branch, detail) | `toGhEventView` returned `null`; 0/4 updated | **4/4 updated in-place** (`body` preserved), **0 extra RPCs** |
| `PrDiffView` `parsePatchFiles` count (334 KB / 60-file diff: mount + remount + unchanged re-read) | **4** parses (1 initial + 2 remount + 1 re-read) | **1** parse (1 initial + **0 remount** + **0 re-read**) |
| Isolated `parsePrDiff` vs `cachedParsePrDiff` hit (919 KB / 100-file diff, 10-run avg) | 5.128 ms/call | **0.003 ms/call** |
| `GitGroup.tsx` `pullRequestDetailResource.watch` calls (5 linked PRs: 4 in dashboard/branch, 1 uncached) | **5** watches | **1** watch (only the 1 uncached PR; all 5 rows + stacking rendered) |
| Diff tab file switch `getCompareFile` calls (`a -> b -> a -> b -> a`, 5 views / 2 files) | **5** total (**3** revisit RPCs) | **2** total (**0** revisit RPCs) |
| `SourcePicker` reopen with deferred `listRefs` | Blank until RPC resolved (`false`) | Cached refs rendered immediately (`true`) |

## Gotchas

- `resource.set()` bumps `gens` and clears `loading`, which would discard an in-flight full fetch triggered by `dashboardUpdated` or `pullRequestDetailUpdated`. `pull_request_changed` therefore patches `resource.store.setState(...)` directly so in-flight refreshes stay intact.
- `startEventSync` must gate `invalidateWatchedGhOnReconnect()` on `(reconnecting || attemptSawLive)` rather than `hadConnected`, because on the initial connect `project` / `workspace` / `threadList` snapshots arrive before the `gh` snapshot and would otherwise set `hadConnected = true` before the initial `gh` snapshot landed.
- `ThreadInfoCard.test.tsx` seeds partial `DashboardView` test fixtures without `projectOpen` / `projectMerged`, so `useSummaryPrViews` and `patchPullRequestInCaches` guard those fields with optional chaining.
- `DiffView.test.tsx` calls `cleanup()` and re-renders against the same worktree path across tests; clearing `diffCaches` in `beforeEach` keeps tests isolated while keeping `CompareWorktree` on `mode: "revalidate"` preserves mid-test re-renders.
