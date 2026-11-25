# Perf: gitops ↔ gh bridge, HTTP update checks, and zero-exec gitops paths

## Context

Four latency and freshness gaps lived in `internal/store/gitops` and `internal/store/update`:

1. **`gitops.OpenPR`** always spawned `gh pr view <branch> --json url,number` (measured
   **654.8 ms** median on `alexwaumann/code-foundry`) plus `git symbolic-ref` even when
   `gh.Store` already held the branch's open PR URL in memory.
2. **`gitops.Push` and `gitops.CreatePR`** only refreshed `project.Store` and never
   notified `gh.Store`, leaving PR panels, CI check rollups, and newly created PRs stale
   until the next scheduled poll (up to 60 s).
3. **`update.GhSource`** shelled out to `gh api` (and `gh api --paginate` across every page
   of releases on the `tip` channel, measured **1,537.5 ms** median on
   `alexwaumann/code-foundry`) on every check with no token cache or conditional `ETag`.
4. **`gitops.resolve` and `x.branch`** spawned `git symbolic-ref --quiet --short HEAD`
   (measured **7.6 ms** median) synchronously on every call—including `OpenEditor` and
   `Reveal`, which do not need the checked-out branch.

## Decisions

### Narrow interfaces + daemon bridge (no edits to `internal/store/gh` or `internal/store/project`)

- `gitops.GitHub` (`OpenBranchPR`, `NotifyBranchChanged`) is injected via
  `gitops.Options.GitHub` and implemented by `gitopsGitHubBridge` in
  `internal/daemon/gitops_gh.go` using existing exported `*gh.Store` methods:
  - `OpenBranchPR` scans `gh.Store.CachedPullRequests()` (dashboards + watched branches)
    for an open, non-fork PR matching `(slug, branch)`, picking the most recently updated
    match. On cache hit, `OpenPR` launches the browser immediately without calling `m.gh()`
    or spawning `gh pr view`; on miss, it falls back to `gh pr view`.
  - `NotifyBranchChanged` calls `gh.Store.BranchPullRequests(ctx, slug, branch)` (ensuring
    the branch is watched) followed by `gh.Store.Refresh(ctx, "")` (nudging the poll worker
    without blocking). True no-op pushes (`already up to date` with an existing upstream)
    skip both the project refresh and the GitHub notification.

### Direct `.git/HEAD` reads and targeted post-push refresh

- `OpenEditor` and `Reveal` resolve paths with `needBranch=false` (validating the
  directory and reading `project.Snapshot` in memory, spawning **0 `git` subprocesses**
  and triggering **0 project refreshes**). `Fetch` with an explicit branch and `Pull` with
  an explicit title likewise skip branch probing.
- Operations that need the current branch read `.git/HEAD` directly (`readHeadBranch`,
  supporting standard `.git` directories, linked worktrees/submodules via `gitdir:`, and
  subdirectories), falling back to `git symbolic-ref` only when `.git/HEAD` cannot be
  parsed directly (e.g., reftable `.invalid` placeholder or non-git directories).
- Post-op refreshes in `afterOpLocked` pass the matched registered worktree root
  (`target.worktreePath`, not a subdirectory) to `TouchNow` for non-default feature-branch
  pushes and PR creations instead of calling `Projects.Refresh`. Pushes that set a new
  upstream (`git push -u`) still refresh even when git reports `Everything up-to-date`.
  (Note: the FSEvents watcher on `refs/remotes/origin/*` still triggers its own refresh on
  real pushes until fetch/push watcher coalescing lands separately.)

### Direct HTTP + token cache + ETag in `update.GhSource`

- Replaced `exec.CommandContext(..., "gh", "api", ...)` with an in-process `http.Client`
  (25 s idle timeout matching `gh.HTTPRunner`; note that hourly checks still open a fresh
  connection each hour, and CLI invocations do not share the in-memory cache).
- Added a 15-minute in-memory token cache backed by `gh.GhToken` (or an injected
  `TokenSource`). `gh.ErrNoToken` caches anonymous mode for the TTL; `401 Unauthorized`
  force-refreshes the token once and falls back to anonymous for public repos.
- Added per-channel `ETag` / `If-None-Match` caching in memory for authenticated daemon
  checks (note: GitHub waives rate-limit cost on `304 Not Modified` for authenticated
  requests). For `tip`, page 1's ETag is cached only when page 1 produced the winning tag
  so a page-2 tag cannot go stale behind a page-1 `304`.
- On the `tip` channel, requests `GET /repos/{repo}/releases?per_page=20` (relying on
  GitHub returning releases newest-first) and only follows same-origin `Link` `rel="next"`
  headers if page 1 contains no usable non-draft semver release.

## Measured Results (Apple M3 Pro, Go 1.26, live `alexwaumann/code-foundry`)

### Real before/after measurements

| Path | Before (measured on `main`) | After (measured on branch) |
|---|---|---|
| `git symbolic-ref HEAD` (old `Reveal`/`OpenEditor` probe) | **7.6 ms** median (6.8–8.9 ms, 1 `git` exec) | **0.017 ms** (`17.1 µs` bench, **0 `git` execs**) |
| `OpenPR` (branch PR cached in `gh.Store`) | **654.8 ms** median (514.5–745.1 ms, `gh pr view` + `git`) | **0.046 ms** (`46.4 µs` bench, **0 `git`, 0 `gh` execs**) |
| `update` `tip` channel (live `alexwaumann/code-foundry`) | **1,537.5 ms** median (1,294.9–1,698.8 ms, `gh api --paginate`) | **411 ms** cold auth / **355 ms** `304` / **366 ms** anon (**3.7× faster**, 1 page) |
| `update` `stable` channel (live `alexwaumann/code-foundry`) | **394.5 ms** median (391.5–406.7 ms, `gh api`) | **369 ms** cold auth / **224 ms** `304` / **280 ms** anon (**0 `gh` execs** while token cached) |

### Verification

- Exercised `update.GhSource.Latest` end-to-end against real `api.github.com`
  (`alexwaumann/code-foundry`) on both `stable` (`v0.26.0`) and `tip` (`v0.27.0-tip.10`),
  authenticated (cold + `304`) and anonymous (`ErrNoToken` fallback).
- `go test -race -count=1 ./internal/store/gitops/... ./internal/store/update/... ./internal/daemon/...`
- Full `make check` green + `make attest`.
