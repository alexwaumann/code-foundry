# Diff performance: `cat-file --batch` pool, compare caches, and active-worktree debounce

## Context

Profiling the Diff tab and project store revealed four avoidable sources of git subprocess
overhead and UI latency:

1. **`CompareFile` spawned 3–7 serial git subprocesses per file click.** Each call ran
   `rev-parse HEAD`, resolved both refs with `rev-parse`, and then sequentially ran
   `ls-tree --long` + `cat-file blob` for Old and New sides.
2. **`CompareWorktree` ran redundant `ls-files` calls and recounted untracked files from
   scratch.** Clean worktrees still ran `ls-files --unmerged` and `ls-files --others`, and
   dirty worktrees reopened and recounted every untracked file on every compare instead of
   reusing `detail.go`'s stat-keyed `lineMemo`.
3. **Immutable commit queries and unchanged `ListRefs` re-invoked git on every call.**
   Commit-to-commit `CompareWorktree`, `CompareFile`, `CompareCommits`, `CompareCommitBody`,
   and repeated `ListRefs` calls did not cache results in the daemon.
4. **Active worktrees waited for the full 1s `TreeDebounce`.** Live/watched worktrees
   shared the same 1s file-tree coalescing window as idle worktrees.

## Decisions

### 1. Persistent idle-reaped `git cat-file --batch-command -Z` pool (`catfile.go`)

- Enabled only when `Git.runner` is a real `ExecRunner` (`ExecRunner` or `*ExecRunner`);
  custom test runners (`auditRunner`, `countingRunner`, fakes) fall back cleanly to
  `g.runner.Run`.
- Uses `git -c core.fsmonitor=false -c diff.autoRefreshIndex=false cat-file --batch-command -Z`
  with `GIT_NO_LAZY_FETCH=1` and `Setsid: true`, matching `ExecRunner`'s security boundary.
  `-Z` uses NUL delimiters so paths with spaces, tabs, colons, leading dashes, or quotes
  work unambiguously.
- Single worker checkout serves both `info <rev>:<path>` (metadata + size check before
  streaming) and `contents <oid>` (streaming up to `FileDiffMax` and draining any excess
  directly into `io.Discard`). Also used for `SourceStaged` (`info <oid>` + `contents <oid>`).
- Bounded to `maxCatFileWorkersPerRepo = 4` idle workers per repository and
  `maxCatFileTotalIdle = 16` globally, reaped after `defaultCatFileIdleTimeout = 45s` via a
  single lazy `time.AfterFunc` timer (no idle goroutines).
- Process-group cleanup (`killGroup`) + `cmd.Wait()` on broken pipe/EOF (with one transparent
  retry on a reused worker), `context.AfterFunc` cancellation, `Unregister`, and `Close`
  prevent zombie processes and PID-reuse races.
- **Partial clone gotcha:** `git cat-file --batch-command` under `GIT_NO_LAZY_FETCH=1`
  reports a missing promisor object identically to an absent path (`<spec> missing`).
  Each worker checks `<commonDir>/config` once on spawn for `promisor`; in partial clones,
  a `missing` result falls back to `ls-tree` + `cat-file blob` so `isMissingObject` still
  produces `objectsMissing` without triggering lazy fetch.
- `CompareFile` now reads `res.Old` and `res.New` concurrently (and reads once when both
  sides are identical with the same path).

### 2. Redundant subprocess skipping, `lineMemo` reuse, and `openCompare` caching

- **`statusDiskStamp` on `wtSlot`:** Right before `git status` runs in `g.status`, the store
  snapshots `(dev, ino, size, mtime)` of `.git/index` and the worktree root directory.
  - `CompareWorktree` skips `ls-files --unmerged` when `Status` is refreshed with no error,
    `Status.Conflicted == 0`, `HEAD` matches `wt.Head`, and `.git/index` stamp is unchanged
    (git atomically renames `index.lock` over `index`, always changing the inode).
  - `CompareWorktree` skips `ls-files --others` under the same conditions plus
    `Status.Untracked == 0`, unchanged worktree root stamp, and no pending status job in
    debouncers or scheduler.
- **`lineMemo` sharing:** `addUntracked` reads and updates `g.details.lines` (immutable
  copy-on-write maps under `g.details.mu`), avoiding re-reading unchanged untracked files.
- **`openCompare` context cache & `readHeadFast`:**
  - `CompareFile` skips `currentBase` (`HEAD` + `merge-base`) when neither side is
    `SourceMergeBase`; `CompareCommits` skips it when both sides are `SourceRef`.
  - `readHeadFast` reads `<gitDir>/HEAD` and its loose ref file directly (falling back to
    `git rev-parse` for unborn branches, packed refs, or reftables).
  - Resolved `openCompare` results are cached up to 5s (128 entries) and validated against
    current `HEAD`, `st.base`, and loose ref + `packed-refs` disk stamps so `git commit`,
    `git branch -D`, `git rebase`, and `git checkout` invalidate immediately without FSEvents.

### 3. Bounded LRU caches and event-invalidated `ListRefs` cache (`compare_cache.go`)

- Immutable commit-to-commit results use goroutine-safe entry- and byte-bounded LRUs with
  defensive copies on both `put` and `get`:
  - `CompareWorktree` unfiltered `[]CompareChange`: 64 entries / 16 MiB
  - `CompareFile` `CompareSides`: 256 entries / 24 MiB
  - `CompareCommits` `CompareLog` (non-shallow): 64 entries / 8 MiB
  - `CompareCommitBody` `CompareCommitMessage`: 512 entries / 4 MiB
  - Verified commit SHAs: 2,048 entries
- `ListRefs` is cached per project with a generation counter (preventing stale in-flight
  `for-each-ref` calls from repopulating after invalidation) and defensive slice clones.
  Invalidated on `reconcile`, `resolveBase` (`jobBase`), `CreateWorktree`, `RemoveWorktree`,
  `DeleteBranch`, `Unregister`, and FSEvents matching `<commonDir>/refs/`, `packed-refs`,
  `FETCH_HEAD`, or rescan flags.

### 4. Faster active-worktree tree debounce (`sched.go`, `activity.go`, `fsevents.go`, `store.go`)

- Added `debouncer.triggerWindow(k, window)` so one debouncer serves both active and idle
  worktrees without overlapping timers or breaking `treeDeb.setClock` tests.
- Default `ActiveTreeDebounce` is `300ms` (using `worktreeActive`: live thread or watched
  `WorktreeDetail`), while idle worktrees stay at `1s` (`DefaultTreeDebounce`). When a caller
  or test sets `Options.TreeDebounce` explicitly without `Options.ActiveTreeDebounce`, the
  explicit `TreeDebounce` is respected.

## Measurements (Before vs After)

Measured on Apple M3 Pro (`darwin/arm64`), Go 1.26, git 2.52.0, using `b1_bench_test.go`
(`RUN_B1_METRICS=1 go test -v -run=TestB1SubprocessCounts -bench=BenchmarkB1 -benchmem -benchtime=500ms ./internal/store/project/...`):

| Benchmark / Scenario | Before | After | Delta |
|---|---|---|---|
| `CompareFile` commit-to-commit (10 distinct files, cold pool) | 70 git spawns (7.0/call) | 4 git spawns (0.4/call) | **-94.3% spawns** |
| `CompareFile` commit-to-commit (10 distinct files, warm pool) | 70 git spawns (7.0/call) | 0 git spawns (0.0/call) | **-100% spawns** |
| `CompareFile` commit-to-commit (10 repeated files, cached) | 70 spawns (7.0/call), 40.81 ms/op | 0 spawns (0.0/call), 15.1 µs/op | **2,702x faster** |
| `readRevSide` (warm `cat-file --batch`, rotating 20 files) | 12.77 ms/op (57.8 KB/op) | 0.192 ms/op (4.8 KB/op) | **66.4x faster** |
| `CompareFile` merge-base-to-worktree (10 files after `CompareWorktree`) | 30 spawns (3.0/call), 19.54 ms/op | 0 spawns (0.0/call), 0.265 ms/op | **73.7x faster** |
| `CompareWorktree` clean worktree (5 calls) | 20 spawns (4.0/call), 24.40 ms/op | 5 spawns (1.0/call), 7.40 ms/op | **3.3x faster, -75% spawns** |
| `CompareWorktree` dirty + 15 untracked files (5 calls) | 20 spawns (4.0/call), 26.25 ms/op (1.11 MB/op) | 10 spawns (2.0/call), 12.62 ms/op (86 KB/op) | **2.08x faster, -92% B/op** |
| `CompareWorktree` commit-to-commit (5 calls) | 20 spawns (4.0/call), 24.53 ms/op | 1 spawn (0.2/call), 85.3 µs/op | **287.6x faster** |
| `CompareCommitBody` repeated (10 calls) | 20 spawns (2.0/call), 11.42 ms/op | 2 spawns (0.2/call), 13.8 µs/op | **825.6x faster** |
| `ListRefs` repeated (10 calls) | 10 spawns (1.0/call), 5.83 ms/op | 1 spawn (0.1/call), 170.1 ns/op | **34,288x faster** |
