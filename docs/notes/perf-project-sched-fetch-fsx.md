# Project scheduler priority, fast CreateWorktree, guarded mergedByContent, fetch coalescing, precomputed gitEnv, and FSEvents FileIndex

Status: done on `perf/project-sched-fetch-fsx`. Verified with `go test -race ./internal/store/project/... ./internal/fsx/... ./internal/daemon/...` and `make check`.

## Why

On repositories with several worktrees, background polls, periodic fetches, and `CreateWorktree` were multiplying git subprocesses and contending with user-waited RPCs on a flat FIFO scheduler:

1. **Flat scheduler queue**: Interactive calls (`Refresh`, `WorktreeDetail`, `Register`, `CreateWorktree`, `RemoveWorktree`, `TouchNow`) and active-worktree FSEvents waited behind queued background polls and idle-worktree refreshes.
2. **Slow `CreateWorktree`**: Creating a worktree called `g.refresh(ctx, m.ID)`, which ran a full `jobReconcile`, `jobBase`, and `jobStatus` across every existing worktree in the project (and double-fanned `status` via `reconcile` → `jobBase` → `statusKeys` + `wait(statusKeys)`).
3. **Unconditional `mergedByContent`**: Even the main worktree ran `git merge-tree --write-tree` during status refreshes whenever locally diverged from `origin/<default>`, even though main is never a leftover or cleanup candidate. (Non-main dirty and unmanaged worktrees still evaluate `mergedByContent` so `Worktree.Landed()` stays accurate for "Worktrees without threads", memoized per `(head, base)`.)
4. **Redundant background git rounds**:
   - `resolveBase` fanned out `jobStatus` to every worktree even when the resolved `(ref, sha)` was identical to the previous value.
   - A single background `git fetch --prune --quiet` triggered `afterFetch()` (`jobReconcile` → `jobBase` → N×`jobStatus`) **plus** FSEvents `FETCH_HEAD` (`actReconcile`) **plus** `refs/remotes/origin/*` (`actStatusAll`), causing 2–3 full sweeps per fetch.
   - Live backstop polls ran every 2 min (`DefaultPollInterval`) right next to the 2 min live fetch, and idle polls ran every 10 min out of phase with the 15 min idle fetch.
   - Unchanged status refreshes republished `WorktreeUpdated` every 1 min (`republishAfter`) for **every** worktree (including linked worktrees whose `RefreshedAt` is never shown in the UI).
5. **Per-invocation `gitEnv` rebuilds**: `ExecRunner.exec` called `os.Environ()` and filtered/allocated slices on every git subprocess.
6. **5-second `fsx.FileIndex` TTL**: Every `@` file completion or `Cmd+P` search spaced more than 5 s apart re-ran `git ls-files` even though the project store's FSEvents stream already tracks edits in every registered git checkout.

## What changed

| File | Change |
|---|---|
| `internal/store/project/sched.go` | 2-tier priority queue (`prioHigh`, `prioLow`) with promotion when a `prioHigh` request targets an already-queued `prioLow` job (or pending rerun of a running job). `wait` defaults to `prioHigh`; `waitPrio` allows background callers (`autoPullPass`) to wait at `prioLow`. |
| `internal/store/project/store.go`, `made.go` | Fast `CreateWorktree` (`registerCreatedWorktree`): registers the new worktree slot and its fs routes directly, syncs the stream, publishes `ProjectUpdated`, waits on `jobBase` only if unset or if `CreateWorktree` fetched a start point, and waits only on the new worktree's `jobStatus` (with `reconcile`'s `listedAt` guard preserving newly created slots across concurrent reconciles and a fallback to `g.refresh`). If a wait fails (a cancelled request), CreateWorktree's undo removes the worktree from disk and then drops its slot with `WorktreeRemoved` + `ProjectUpdated` (`dropUndoneWorktree`, `docs/notes/createworktree-rollback.md`); subscribers have already seen it. `Refresh` explicitly republishes the main worktree's `RefreshedAt`. Unchanged `RefreshedAt` republishing is scoped to `next.IsMain` only (`republishAfter = 1 * time.Minute`). `DefaultPollInterval` raised from 2 m to 5 m. |
| `internal/store/project/base.go`, `merged.go` | `resolveBase` only fans out `jobStatus` to all worktrees when `(ref, sha)` actually changed; otherwise it refreshes only uninitialized worktrees (`RefreshedAt.IsZero()`). `baseCounts` skips `mergedByContent` for the main worktree (`!next.IsMain`) while keeping it (memoized per `(head, base)`) for all non-main worktrees so `Landed()` stays accurate. |
| `internal/store/project/watch.go`, `fetchpool.go`, `fsevents.go`, `autopull.go` | `FETCH_HEAD` maps to `actStatusAll` (`jobBase`) instead of `actReconcile`, coalescing with `refs/remotes/origin/*` on the same debouncer key; `refs/remotes/origin/HEAD` maps to `actReconcile` so `DefaultBranch` updates on first fetch; `packed-refs` also requests worktree statuses so pruned packed remote refs update ahead/behind. `fetchPool` tracks in-flight and just-completed fetches (and triggers a low-priority `jobBase` on fetch failure so suppressed external ref events are not lost). `afterFetch` requests `jobBase` (not `jobReconcile`), and `autoPullPass` waits on `jobBase` + default-branch `jobStatus` only. Non-default loose remote-ref updates (`origin/<feat>`) refresh only worktrees on/tracking that branch. |
| `internal/store/project/activity.go`, `detail.go` | `DefaultIdlePollInterval` aligned to 15 m (matching `DefaultIdleFetchInterval`). `poll` explicitly schedules low-priority `jobReconcile` + `statusKeys` so the backstop still refreshes missed edits even when `resolveBase` skips unchanged bases. Active worktrees (live thread or watched detail) get `prioHigh` on FSEvents/`Touch`/`detailAfterStatus`; idle worktrees and background work get `prioLow`. |
| `internal/store/project/runner.go` | `NewExecRunner` precomputes immutable `env` and `guardedEnv` once at store start (`Start`), while zero-value `ExecRunner{}` still reads `os.Environ()` per call so tests using `t.Setenv` continue to work safely. `gitEnv` filters `fsx.GitEnv(base)` in place. |
| `internal/fsx/files.go`, `internal/api/filesystem.go`, `internal/daemon/fileindex_watch.go`, `internal/daemon/stores.go`, `internal/daemon/daemon.go` | Added `WatchedFileCacheTTL` (5 m), `SetWatched(root, watched)`, and generation-guarded `Invalidate(root)` (prevents stale in-flight listings from poisoning the cache) on `fsx.FileIndex`. Wired `startFileIndexWatch` to `project.Event` so git worktrees use the 5 m TTL and invalidate on `WorktreeFilesChanged` (`FileCreated`/`FileRemoved`/`FileRenamed`, `.gitignore`, or truncated), `WorktreeUpdated` (HEAD/branch/detached/staged/modified/untracked changes only — not behind/freshness), and removals. Plain non-git projects stay unwatched (5 s TTL). |

## Changes from earlier design notes

- **`docs/notes/fsevents-watcher.md`**: `FETCH_HEAD` previously mapped to `actReconcile` (inherited from before `jobBase` existed). Because `git fetch` never adds/removes worktrees or edits remote config, `FETCH_HEAD` now maps to `actStatusAll` (`jobBase`), letting `FETCH_HEAD` and `refs/remotes/origin/*` coalesce into a single debounced `jobBase`.
- **`docs/notes/git-activity-tiers.md`**: Live backstop poll moved from 2 m to 5 m (`DefaultPollInterval`), and idle backstop poll moved from 10 m to 15 m (`DefaultIdlePollInterval`), aligning idle poll 1:1 with `DefaultIdleFetchInterval` (15 m). Live FSEvents (1 s tree / 300 ms git) and thread `Touch`/`TouchNow` still drive interactive latency; the poll remains a backstop for missed events, failed stream starts, or reftable refs.
- **`docs/notes/projects-polish-2.md`**: Unchanged `RefreshedAt` republishing (`republishAfter = 1 m`) is now scoped to the main worktree only. `ProjectTitle.tsx` only reads the main worktree's `refreshedAtMs`; linked worktrees no longer emit periodic `WorktreeUpdated` wakeups when unchanged, while explicit `Refresh` always republishes the main worktree's `RefreshedAt`.
- **`docs/notes/cleanup-eligibility.md`**: `mergedByContent` during status refreshes now skips the main worktree (`!next.IsMain`, since main is never a cleanup or leftover candidate) while remaining enabled and memoized per `(HEAD, base)` for all non-main worktrees (including dirty and unmanaged) so `Landed()` stays accurate.
- **`docs/notes/repo-detail-cache.md`**: `resolveBase` no longer unconditionally fans out `jobStatus` to every worktree when `(ref, sha)` did not change; it refreshes only worktrees with zero `RefreshedAt` unless the base moved.

## Measurements (before vs after)

All measurements were captured on Apple M3 Pro (darwin/arm64, git 2.52.0) running the exact same test harness before edits (`HEAD` = `df1a80c9f0`) and after edits.

| Scenario | Before | After | Delta |
|---|---|---|---|
| `CreateWorktree` (10 existing worktrees → 11 total) | 158 ms, 40 git cmds (23 `status`, 3 `worktree`, 8 `rev-parse`, 3 `remote`, 1 `symbolic-ref`) | 72 ms, 12 git cmds (1 `status`, 2 `worktree`, 6 `rev-parse`, 1 `remote`, 0 `symbolic-ref`) | **-54% wall time, -70% git cmds (-96% `status`)** |
| `resolveBase` with unchanged base SHA (10 worktrees) | 11 git cmds (**10 `jobStatus`**, 1 `rev-parse`) | 1 git cmd (**0 `jobStatus`**, 1 `rev-parse`) | **-91% git cmds (0 status fan-out)** |
| Background fetch cycle — no-op (remote unchanged, 10 worktrees, `fetch` + FSEvents) | 31 git cmds (1 `fetch`, 2 reconciles, 2 `rev-parse`, **20 `status`**) | 2 git cmds (1 `fetch`, **0 reconciles**, 1 `rev-parse`, **0 `status`**) | **-93.5% git cmds** |
| Background fetch cycle — moved (`origin/main` +1 commit, 10 worktrees, `fetch` + FSEvents) | 52 git cmds (1 `fetch`, 2 reconciles, 3 `rev-parse`, **30 `status`**, 10 `rev-list`) | 22 git cmds (1 `fetch`, **0 reconciles**, 1 `rev-parse`, **10 `status`**, 10 `rev-list`) | **-57.7% git cmds (-67% `status`)** |
| `mergedByContent` across 4 diverged worktrees (main, unmanaged, managed-dirty, managed-clean) | **4 `merge-tree`** | **3 `merge-tree`** (main skipped; non-main memoized per `(head, base)`) | **-25% `merge-tree` calls** |
| Scheduler priority (20 queued bg jobs @ 15 ms, 2 workers) | 20 bg jobs ahead of interactive, **176 ms** wait | 0–1 concurrent bg job, **<1 ms (`0s`)** wait | **interactive runs immediately** |
| `fsx.FileIndex` on watched repo (10 searches spaced 6 s apart, past 5 s TTL) | **10 `git ls-files`**, 0 hits (**0.0%** hit rate) | **1 `git ls-files`**, 9 hits (**90.0%** hit rate) | **-90% `git ls-files`** |
| `gitEnv` per git invocation (`BenchmarkGitEnv`) | 2974 ns/op, 3584 B/op, 3 allocs/op | **1.73 ns/op, 0 B/op, 0 allocs/op** (`NewExecRunner`); 1053 ns/op, 2 allocs/op uncached | **0 allocs/op in daemon** |

## Tests

- `internal/store/project/sched_test.go`: `TestSchedulerPriorityAndPromotion`, `TestSchedulerRunningRerunPromotesPriority`
- `internal/store/project/perf_opt_test.go`: `TestCreateWorktreeFastPath`, `TestResolveBaseUnchangedSkipsStatusFanout`, `TestFetchCoalescesWatcherBurst`, `TestMergedByContentGuardAndDirtyToCleanTransition`, `TestRemoteFeatureRefUpdatesOnlyMatchingWorktree`
- `internal/store/project/republish_test.go`: `TestLinkedWorktreeSkipsRepublishAndRefreshUpdatesMain`
- `internal/store/project/runner_test.go`: `TestNewExecRunnerPrecomputesEnv`
- `internal/fsx/files_test.go`: `TestFileIndexWatchedTTLAndInvalidate`, `TestFileIndexInvalidateDuringInflight`
- `internal/daemon/fileindex_watch_test.go`: `TestFilesChangedInvalidates`, `TestFileIndexWatchEvents`
