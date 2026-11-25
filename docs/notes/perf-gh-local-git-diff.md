# gh store: local-git PR diffs & commit files with SQLite diff cache

Status: implemented on branch `perf/gh-local-git-diff`.

## What changed

1. **Daemon-injected `LocalGitProvider` interface (`internal/store/gh/pr_files.go`, `internal/store/gh/store.go`, `internal/daemon/gh_local_git.go`, `internal/daemon/stores.go`)**:
   - Added optional `Options.LocalGit LocalGitProvider` to `gh.Store` with two methods:
     - `LocalPRDiff(ctx, slug, baseSHA, headSHA, maxBytes) (diff []byte, truncated, ok bool)`
     - `LocalPRFile(ctx, slug, commitSHA, filePath, maxBytes) (contents []byte, truncated, binary, notFound, ok bool)`
   - `internal/store/gh` never imports `internal/store/project`; `internal/daemon/gh_local_git.go` bridges `*project.Git` into `gh.Options.LocalGit`.
   - `PullRequestDiff` checks in-memory cache -> `LocalGit.LocalPRDiff` (when `!refresh` and both `baseSHA` and `headSHA` are known full commit SHAs, sourced from `cachedFull` or `summaries`) -> SQLite `gh_pr_diffs` -> GitHub REST (`application/vnd.github.v3.diff`). `refresh=true` bypasses all caches and local git to fetch authoritatively from GitHub REST. Renamed repositories map through `Snapshot.LocalRepo` before querying local clones.
   - `PullRequestFile` checks in-memory cache -> `LocalGit.LocalPRFile` -> GitHub REST (`application/vnd.github.raw+json`).
   - Local hits bypass the paced GitHub worker completely (0 HTTP requests, 0 `MinGap`/`UserGap` waits, works offline and during rate-limit pauses). Any `ok=false` result falls back seamlessly to SQLite / GitHub REST.

2. **Guarded local-git PR diff & file readers (`internal/store/project/local_pr.go`, `internal/store/project/catfile.go`)**:
   - `project.Git.LocalDiff` searches all registered git projects matching `strings.EqualFold(p.GitHubSlug, slug)` (supporting multiple local clones of the same repo).
   - Verifies both `baseSHA^{commit}` and `headSHA^{commit}` exist locally via the pooled `git cat-file --batch-command -Z` workers (`catFilePool.commitsExist`, falling back to `rev-parse --verify` when disabled), computes `git merge-base <baseSHA> <headSHA>` for exact GitHub three-dot parity, and streams `git -c diff.renames=true diff --no-ext-diff --no-color --no-textconv --diff-algorithm=myers --src-prefix=a/ --dst-prefix=b/ -M -U3 --submodule=short --ignore-submodules=none <mergeBase> <headSHA> --` under `guarded(ctx)` (`-c core.fsmonitor=false -c diff.autoRefreshIndex=false`, `GIT_NO_LAZY_FETCH=1`).
   - Streaming stops immediately once output exceeds `maxBytes` (`PullRequestDiffMax = 4 MiB`), canceling the git subprocess and trimming to the last whole line (`\n`). Missing commits, shallow boundaries, unrelated histories, or missing partial-clone objects all return `ok=false`.
   - `project.Git.LocalCommitFile` verifies `<commitSHA>^{commit}` and reads `<commitSHA>:<filePath>` through `catFilePool.readCommitFile` (generalized `readBlobMax`, with `ls-tree` + `cat-file blob` fallback when the pool is disabled). Directories (`tree`) and submodules (`commit`/`submodule`) return `notFound=true, ok=true` matching GitHub raw-file semantics.

3. **Bounded SQLite diff cache (`internal/store/gh/schema.sql`, `internal/db/migrations/0069_gh_pr_diffs.sql`, `internal/store/gh/cache.go`)**:
   - Added `gh_pr_diffs (repo_slug, number, head_sha, base_sha, diff, truncated, fetched_at)` in both migration `0069` and `gh/schema.sql` (plus `wayback/0061_layout.sql` for rollback tests).
   - Persists REST-fetched diffs (when `head_sha` is known) and caps the table to the 32 most recently fetched rows (`diffDBCacheMax = 32`); startup `cache.prune` also drops rows older than `cacheRetention` (7 days).
   - On restart for uncloned or fork PRs, `PullRequestDiff` serves the persisted diff immediately when `head_sha` and `base_sha` match and `!refresh`.

## Decisions and gotchas

- **Shallow clones**: `LocalDiff` checks `<commonDir>/shallow` (non-empty) and falls back immediately to GitHub REST (`ok=false`), because `git merge-base` in a shallow clone can exit 0 with an older ancestor instead of the true merge base.
- **Partial clones and `notFound`**: under `GIT_NO_LAZY_FETCH=1`, `git cat-file --batch-command` reports `missing` identically for an unfetched promisor blob and a genuinely absent path. `readCommitFile` therefore falls back to `git ls-tree` on every `missing` result: if `ls-tree` finds the path in the tree (and `cat-file blob` fails) or `ls-tree` itself fails, `LocalCommitFile` returns `ok=false` so GitHub REST answers authoritatively — even for partial clones configured via `extensions.partialClone`, included configs, or global config.
- **`.gitattributes` & user config isolation**: `LocalDiff` runs with `--attr-source=<empty-tree>` (git ≥ 2.40; older git cleanly falls back to GitHub REST) plus explicit `-c diff.renames=true -c diff.renameLimit=0 -c diff.interHunkContext=0 -c diff.suppressBlankEmpty=false -c diff.indentHeuristic=true -c core.quotePath=true -O /dev/null --full-index --src-prefix=a/ --dst-prefix=b/ -M -U3 --diff-algorithm=myers --no-ext-diff --no-color --no-textconv --submodule=short --ignore-submodules=none`, preventing working-tree `.gitattributes` (such as `-diff` on generated dist files, e.g. PR #893) and user `~/.gitconfig` settings from diverging from GitHub's `v3.diff`.
- **Symlinks**: `LocalCommitFile` returns the symlink target text stored in git, whereas GitHub's raw endpoint follows in-repo symlinks.
- **SQLite diff cache bounds**: `gh_pr_diffs` only persists/hits when both `head_sha` and `base_sha` are full commit SHAs (`IsCommitSHA`) and `len(diff) <= 1 MiB` (`diffDBMaxBytes`), bounding worst-case DB growth to 32 rows / ≤ 32 MiB.
- **`refresh=true` skips local git**: the Diff strip's refresh button fetches fresh PR state even if `cachedFull` still holds an older head SHA; bypassing memory, local git, and SQLite on `refresh=true` preserves authoritative refresh behavior.
- **SQLite wayback sync**: adding migration `0069_gh_pr_diffs.sql` also requires mirroring `gh_pr_diffs` in `internal/store/gh/schema.sql` (checked by `TestDaemonMigrationsCreateEveryGhTable`) and adding `DROP TABLE IF EXISTS gh_pr_diffs` + version `69` to `internal/db/wayback/0061_layout.sql` (checked by `TestLayoutWayBack`).

## Measurements (darwin/arm64)

### Live parity & latency on `alexwaumann/code-foundry` PR #901 (32 files, 248,809 bytes)

| Operation | Before (live GitHub REST via `HTTPRunner`) | After (local git via `project.Git`) | Delta |
|---|---|---|---|
| `PullRequestDiff` (PR #901, 32 files, 248 KiB) | `1,049.5 ms` (`1` HTTPS call) | `34.5 ms` cold / `26.0 ms` warm (`0` HTTPS calls) | `~30–40x` faster, `0` GitHub requests |
| `PullRequestFile` (`internal/store/gh/poll_projects.go`, 15.6 KiB) | `461.2 ms` (`1` HTTPS call) | `231.9 µs` cold / `147.7 µs` warm (`0` HTTPS calls) | `~3,120x` faster, `0` GitHub requests |

- **Diff parity**: verified byte-for-byte identical against GitHub `application/vnd.github.v3.diff` across 5 real PRs (`#901`, `#900`, `#899`, `#898`, `#895` — 101 files, ~644 KiB) ignoring only GitHub's 9-char vs local git's 10-char `index` SHA abbreviation; verified `parsePrDiff` (`gui/frontend/src/components/pr/diffModel.ts`) produces an identical `PrDiffModel` (`32` files, `+1972`/`-381`, all hunks) on PR #901.
- **File parity**: `LocalCommitFile` output matched GitHub `application/vnd.github.raw+json` byte-for-byte (`15,590` bytes).

### Daemon end-to-end harness (`TestGhLocalGitBridgeEndToEndAndPerf`, non-race, 40 ms simulated RTT + pacing)

| Scenario | Before (REST) | After | Delta |
|---|---|---|---|
| Local-repo `PullRequestDiff` | `69.6 ms` (`1` REST call) | `17.4 ms` (`0` REST calls) | `~4.0x` faster, `0` REST calls |
| Local-repo `PullRequestFile` | `68.7 ms` (`1` REST call) | `267 µs` cold / `102 µs` warm (`0` REST calls) | `~675x` faster, `0` REST calls |
| Non-local/fork `PullRequestDiff` after restart | `51.4 ms` (`1` REST call) | `78.6 µs` SQLite hit (`0` REST calls) | `~650x` faster, `0` REST calls |

## Verification

- `go list -f '{{.Imports}}' ./internal/store/gh` confirmed zero import of `internal/store/project`.
- `go test -race -count=1 ./internal/store/gh/... ./internal/store/project/... ./internal/daemon/... ./internal/api/...`
- Full `make check` + `make attest`.
