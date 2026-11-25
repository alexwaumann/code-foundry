# Project store: direct git metadata reading & SQLite cold-start snapshot cache

Two cold-start and reconcile optimizations in `internal/store/project/` (plus additive migration `0069_project_snapshot_cache.sql` in `internal/db/`):

## 1. Direct `.git/config` and ref reading (`internal/store/project/gitmeta.go`)

`reconcile` (`inspect`) previously spawned `git remote`, `git remote get-url origin`, and `git symbolic-ref` / `git rev-parse --verify` (3–7 subprocesses per project) on every reconcile in addition to `git worktree list --porcelain -z`.

When `g.runner` is a real `ExecRunner` (`execRunnerOf`), `directGitMeta` resolves `<gitDir>` and `<commonDir>` (supporting `.git` directories, linked worktrees with `commondir`, and separate-git-dir/submodule `.git` files) and parses `<commonDir>/config` and loose/packed refs directly in Go.

### Fallback safety rules

Direct reading falls back cleanly to `g.runner.Run` on any ambiguity or non-standard configuration:

- Custom/fake test `Runner` implementations (`execRunnerOf` returns false).
- External config overrides: `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_CONFIG`, or any readable system/global gitconfig containing `[include]`, `[includeIf]`, `[url]`, `[remote]`, or unparseable syntax (env vars mirror `ExecRunner.env` when precomputed).
- Repo config containing `[include]`, `[includeIf ...]`, `[url ...]` (`insteadOf` / `pushInsteadOf`), `[extensions] worktreeConfig`, deprecated `[section.subsection]` dot syntax, or syntax errors.
- Legacy `<commonDir>/remotes` or `<commonDir>/branches` directories.
- `[remote "<name>"]` with whitespace in `<name>`, or `[remote "origin"]` with 0 URLs, multiple `url =` entries, an empty `url =`, or a bare boolean `url` key (matching `git remote` and `git remote get-url origin` 100%).
- Reftable ref storage (`extensions.refStorage != files`, `reftable/` directory present, or `HEAD` sentinel `ref: refs/heads/.invalid`), symlinked refs, non-`refs/heads/` `HEAD` symrefs, or `refs/remotes/origin/HEAD` present in `packed-refs`.

## 2. SQLite cold-start snapshot cache (`internal/store/project/cache.go`)

Migration `0069_project_snapshot_cache.sql` adds `project_snapshot_cache (project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE, snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT` (and updates `internal/db/wayback/0061_layout.sql` so rollback tests stay consistent).

### Design and gotchas

- **Immediate hydration on `Start()`**: `hydrateSnapshots` loads versioned JSON payloads (`v: 1`) before `Start()` calls `g.commit(nil)`, populating `DefaultBranch`, `GitHubSlug`, `OriginURL`, `Remotes`, and worktree slots (`Path`, `Branch`, `Head`, `Detached`, `IsMain`, `Status` including `RefreshedAt`, excluding transient `Error` and `Operation`).
- **Disk validation**: project directories that disappeared or flipped `.git` state while down are skipped; worktree directories missing on disk (`os.Stat`) are dropped so deleted worktrees never ghost on startup.
- **Unverified `statusStamp` stays `nil`**: hydrated `wtSlot`s leave `statusStamp`, `entries`, and `base` nil so `CompareWorktree` never trusts an unverified hydrated `Conflicted == 0`, and the first `resolveBase` always fans out live `jobStatus` to every worktree.
- **Startup `ProjectUpdated` preserved**: `projectState.hydrated` ensures the first live `reconcile` after hydration still publishes one `ProjectUpdated` event so startup listeners and reload tests observe initial reconcile completion even when nothing drifted on disk.
- **Non-blocking coalesced writes**: `snapshotCache` coalesces dirty project IDs on a 1s timer in a background goroutine, skips projects currently in `Error` state, uses `INSERT ... SELECT id, ?, ? FROM projects WHERE id = ?` to avoid races with concurrent `Unregister`, and drains synchronously in `Close()` after `g.wg.Wait()` so no writes race `db.Close()`.
- **Corrupt row resilience**: malformed JSON or mismatched schema versions log at debug level and degrade to a normal cold start.

## Measured results (Apple M3 Pro, 5 projects / 15 worktrees)

Measured via `RUN_C6_METRICS=1 go test -v -count=1 -run TestC6Metrics ./internal/store/project` and `go test -run=^$ -bench=BenchmarkC6 -benchtime=5x ./internal/store/project`:

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Cold start to populated `Snapshot()` (`BenchmarkC6ColdStart5Projects15Worktrees`) | 88.73 ms/op | 0.24 ms/op | **367× faster** |
| Cold start to populated `Snapshot()` (`TestC6Metrics`, wrapper) | 154.3 ms (55 git spawns) | 0.3 ms (0 git spawns) | **0 spawns, immediate** |
| `reconcile` across 5 projects (`BenchmarkC6Reconcile5Projects`) | 92.63 ms/op | 34.02 ms/op | **2.72× faster** |
| `reconcile` git spawns across 5 projects (`TestC6Metrics`, wrapper) | 20 (4.0/project, 149.5 ms) | 5 (1.0/project, 48.1 ms) | **-75% spawns (0 metadata spawns)** |
