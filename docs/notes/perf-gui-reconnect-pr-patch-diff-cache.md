# GUI reconnect `since_seq`, PR event cache patching, and diff/refs LRU caches

Six targeted latency and RPC-reduction improvements across the event stream, GitHub stores, thread info card, and diff/refs views.

## Changes

1. **Reconnect `since_seq` / `since_epoch` + gh reconnect invalidations** (`gui/frontend/src/api/events.ts`, `gui/frontend/src/stores/events.ts`, `gui/frontend/src/stores/gh.ts`, `internal/api/events.go`)
   - `watchEvents` accepts optional `{ sinceSeq, sinceEpoch, onEnvelope }` and forwards `sinceSeq` / `sinceEpoch` on `EventService.Watch`.
   - `startEventSync` tracks the highest delivered `(seq, epoch)` across reconnects (advancing `lastSeq` past each delivered event; a slice handler that throws on a live event restarts the stream from snapshots instead, docs/notes/event-handler-throw-resync.md) so brief network or sleep blips replay only missed events from the daemon's 4096-event hub ring instead of re-streaming every source snapshot.
   - When a GUI client resumes at the head (`since_seq == lastSeq`, 0 missed events), `EventService.Watch` sends an immediate `StreamHeartbeat` stamped with the daemon's `epoch` so the client marks the stream open immediately and clears `attemptFirstEvent` (preventing a later mid-stream seq-0 resync from pruning terminals).
   - Settings schema is loaded on startup, when the first epoch connects (retrying if the page mounted before the daemon), and on epoch change. When a reconnect falls back to snapshots (`seq === 0n`), `startEventSync` resets `lastSeq`, prunes exited terminals from the snapshot burst, and calls `invalidateWatchedGhOnReconnect()` once per `gh` snapshot burst so watched `branchPullRequestsResource` and `pullRequestDetailResource` keys refresh immediately.

2. **Remove redundant connect List RPCs** (`gui/frontend/src/stores/events.ts`)
   - Removed parallel `listProjects`, `listTerminals`, and `reconcileThreads` RPCs from `startEventSync`'s `onConnect`, since `EventService.Watch` streams `ProjectSnapshot`, `WorkspaceSnapshot`, `TerminalUpdated`*, and `ThreadListSnapshot` immediately on fresh connect.
   - Marked `useProjectsStore` loaded on `project` snapshot and `useTerminalsStore` loaded on `terminal` events and on `threadList` snapshot (covering the zero-terminal case).

3. **In-place frontend cache patching from `pull_request_changed`** (`gui/frontend/src/api/gh.ts`, `gui/frontend/src/stores/gh.ts`)
   - Mapped `GhEvent.pullRequestChanged` in `toGhEventView` (previously returned `null`).
   - Added `patchPullRequestInCaches` in `applyGhEvent` to update matching PR rows in-place across `dashboardResource`, `branchPullRequestsResource`, and `pullRequestDetailResource` (keeping `body`, `comments`, `commits`, `reviews` intact) while never downgrading an overlaid `"merged"` PR back to `"open"` from a lagging poll event.
   - Since changed (docs/notes/gh-pr-changed-overlay.md): the event carries the daemon's overlaid row, the patch merges only the fields the event's change kinds name, and the detail cache is no longer patched.

4. **Bounded LRU cache for parsed `PrDiffView` models** (`gui/frontend/src/components/pr/diffModel.ts`, `gui/frontend/src/components/diff/PrDiffView.tsx`)
   - Added `cachedParsePrDiff(prKey, diff, headSha)` backed by an 8-entry module-level LRU `Map` keyed by `(prKey, headSha)` and verified against `diff` equality.

5. **Cache-first linked PR display in `GitGroup.tsx`** (`gui/frontend/src/components/sidebar/useLinkedPrs.ts`, `gui/frontend/src/components/threadinfo/GitGroup.tsx`)
   - `GitGroup.tsx` suppresses watching `pullRequestDetailResource` only for linked PRs backed by actively polled summary caches (`dashboardResource` core lists `authored`/`reviewRequested`/`reviewed`/`recentlyMerged`, or a **currently watched** `branchPullRequestsResource` key via `watchedOnly: true`), falling back to `pullRequestDetailResource.watch` for unwatched branch entries or uncached PRs so stale open state cannot persist.

6. **Bounded LRU caches for Diff tab & `SourcePicker` reads** (`gui/frontend/src/components/files/useTabRead.ts`, `gui/frontend/src/components/diff/diffCaches.ts`, `gui/frontend/src/components/diff/DiffView.tsx`, `gui/frontend/src/components/diff/DiffFile.tsx`, `gui/frontend/src/components/diff/SourcePicker.tsx`)
   - Added `createTabReadCache` (bounded by entry count and optional `maxBytes`) and optional `{ cache, mode: "revalidate" | "fresh" }` to `useTabRead`, ensuring external `cache.invalidate` never marks a mounted hook `loading: true` when no fetch is in flight.
   - `DiffFile` uses a 32-entry / 16 MiB cache with `mode: "revalidate"` for live comparisons (working tree / index: instant cached render while revalidating so edits with unchanged line counts are never missed, and `sameSides` prevents re-parsing when unchanged) and `mode: "fresh"` for immutable commit comparisons (`0` revisit RPCs).
   - `DiffView` (`CompareWorktree` / `ListCompareCommits`) uses 24-entry caches (`mode: "fresh"` for commit views, `mode: "revalidate"` for live comparisons); `SourcePicker` uses a 32-entry `mode: "revalidate"` cache. `fileStamps.ts` and `useIndexChanges` remain untouched.

## Measurements (before vs after)

| Metric | Before | After |
|---|---|---|
| Fresh connect unary list RPCs (`listProjects` + `listTerminals` + `listThreads`) | 3 (6 after 1 reconnect) | **0** (**0** after 1 reconnect) |
| Reconnect after blip (`seq=2, epoch="ep-1"`) | `sinceSeq=0`, 3 snapshots, 0 replayed | `sinceSeq=2, sinceEpoch="ep-1"`, **0 snapshots**, **1 incremental replay** |
| `pull_request_changed` cache propagation (dashboard, branch, detail) | `toGhEventView` returned `null`; 0 updated | Updated in-place (`body` preserved, merged state never downgraded), **0 extra RPCs** (detail no longer patched since gh-pr-changed-overlay.md) |
| `PrDiffView` `parsePatchFiles` count (334 KB / 60-file diff: mount + remount + unchanged re-read) | **4** parses | **1** parse (**0** remount, **0** re-read) |
| Isolated `parsePrDiff` vs `cachedParsePrDiff` hit (919 KB / 100-file diff, 10-run avg) | 5.128 ms/call | **0.003 ms/call** |
| `GitGroup.tsx` `pullRequestDetailResource.watch` calls (5 linked PRs: 3 core dashboard/watched branch, 2 uncached/unwatched) | **5** watches | **2** watches (only uncached/unwatched PRs) |
| Diff tab file switch: immutable commit revisit (`a -> b -> a`) / live revisit | Blank loading state + RPC every revisit | **0** revisit RPCs (immutable commit); **instant cached paint** + background revalidation with `sameSides` identity preservation (live) |
| `SourcePicker` reopen with deferred `listRefs` | Blank until RPC resolved (`false`) | Cached refs rendered immediately (`true`) |

## Verification

- Vitest unit tests (`useTabRead.test.ts`, `DiffView.test.tsx`, `diffModel.test.ts`, `ThreadInfoCard.test.tsx`, `eventsReconnect.test.ts`, `gh.test.ts`)
- Playwright e2e (`live-bottom.spec.ts` and `search-row.spec.ts` exercising daemon restart & terminal pruning)
- Full `make check` + `make attest`.
