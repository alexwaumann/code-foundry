# Perf: gitops ↔ gh bridge, keep-alive update checks, and zero-exec gitops paths

## Context

Three performance and freshness bottlenecks lived in `internal/store/gitops` and
`internal/store/update`:

1. **`gitops.OpenPR`** always spawned `gh pr view <branch> --json url,number` (~1–2 s for
   cold CLI launch, macOS Keychain lookup, and TLS handshake) even when `gh.Store` already
   held the branch's open PR URL in memory.
2. **`gitops.Push` and `gitops.CreatePR`** only refreshed `project.Store` and never
   notified `gh.Store`, leaving PR panels, CI check rollups, and newly created PRs stale
   for up to a full poll interval (60 s).
3. **`update.GhSource`** shelled out to `gh api` (and `gh api --paginate` across every page
   of releases on the `tip` channel) on every hourly check with no HTTP keep-alive, no
   token cache, and no conditional `ETag` caching.
4. **`gitops.resolve` and `x.branch`** spawned `git symbolic-ref --quiet --short HEAD`
   synchronously on every call—including `OpenEditor` and `Reveal`, which do not need the
   checked-out branch—and `Push`/`CreatePR` always triggered a full project reconcile
   (`Projects.Refresh`) even when pushing a single non-default feature branch or a no-op
   push.

## Decisions

### Narrow interfaces + daemon bridge (no edits to `internal/store/gh` or `internal/store/project`)

- `gitops.GitHub` (`OpenBranchPR`, `NotifyBranchChanged`) is injected via
  `gitops.Options.GitHub` and implemented by `gitopsGitHubBridge` in
  `internal/daemon/gitops_gh.go` using only existing exported `*gh.Store` methods:
  - `OpenBranchPR` scans `gh.Store.CachedPullRequests()` (dashboards + watched branches)
    for an open, non-fork PR matching `(slug, branch)`, picking the most recently updated
    match. On cache hit, `OpenPR` launches the browser immediately without calling `m.gh()`
    or spawning `gh pr view`; on miss, it falls back to `gh pr view`.
  - `NotifyBranchChanged` calls `gh.Store.BranchPullRequests(ctx, slug, branch)` (ensuring
    the branch is watched) followed by `gh.Store.Refresh(ctx, "")` (marking the next poll
    due immediately and nudging the worker without blocking).
- Keeping the bridge in `internal/daemon/gitops_gh.go` keeps the diff to
  `internal/daemon/stores.go` to two lines and avoids merge conflicts with sibling work in
  `internal/store/gh/`.

### Direct `.git/HEAD` reads and minimal project refreshes

- `OpenEditor` and `Reveal` resolve paths with `needBranch=false` (validating the
  directory and reading `project.Snapshot` in memory, spawning **0 `git` subprocesses**
  and triggering **0 project refreshes**). `Fetch` with an explicit branch and `Pull` with
  an explicit title likewise skip branch probing.
- Operations that need the current branch read `.git/HEAD` directly (`readHeadBranch`,
  supporting standard `.git` directories, linked worktrees/submodules via `gitdir:`, and
  subdirectories), falling back to `git symbolic-ref` only when `.git/HEAD` cannot be
  parsed directly (e.g., reftable `.invalid` placeholder or non-git directories).
- Post-op refreshes in `afterOpLocked` use `TouchNow(worktreePath)` (via optional
  `worktreeToucher` implemented by `project.Store`) for non-default feature-branch pushes
  and PR creations instead of reconciling every worktree in the project, and skip
  refreshing altogether on no-op (`already up to date`) or non-mutating operations
  (`OpenEditor`, `Reveal`, `OpenPR`, `OpenURL`).

### Keep-alive HTTP + ETag caching in `update.GhSource`

- Replaced `exec.CommandContext(..., "gh", "api", ...)` with a persistent keep-alive
  `http.Client` (HTTP/2 enabled, 25 s idle timeout matching `gh.HTTPRunner`).
- Added a 15-minute in-memory token cache backed by `gh.GhToken` (or an injected
  `TokenSource`). `gh.ErrNoToken` caches anonymous mode for the TTL so unauthenticated
  public-repo checks do not spawn `gh` on every run; `401 Unauthorized` force-refreshes
  the token once and falls back to anonymous for public repos.
- Added per-channel `ETag` / `If-None-Match` caching so `304 Not Modified` returns the
  cached release tag at 0 GitHub rate-limit cost.
- On the `tip` channel, requests `GET /repos/{repo}/releases?per_page=20` (GitHub returns
  releases newest-first) and only follows same-origin `Link` `rel="next"` headers if page 1
  contains no usable non-draft semver release.

## Measured Results (Apple M3 Pro, Go 1.26)

- `BenchmarkOpenPRCacheHit`: **46.4 µs/op** (0 `git` subprocesses, 0 `gh` subprocesses;
  previously ~1–2 s for `gh pr view` + 2 `git symbolic-ref` execs).
- `BenchmarkRevealZeroGitExecs`: **17.1 µs/op** (0 `git` subprocesses; previously 1
  synchronous `git symbolic-ref` exec per `Reveal` / `OpenEditor`).
- `BenchmarkGhSourceETag304`: **34.2 µs/op** over loopback keep-alive HTTP on `304 Not
  Modified` (0 `gh` subprocesses, 0 GitHub API rate-limit cost, 1 page fetched on `tip`
  miss instead of paginating full release history).
- Verified with `go test -race` across `internal/store/gitops`, `internal/store/update`,
  `internal/daemon`, and full `make check`.
