# Phase 1b: Repo store

Status: done. `make check` is green. Verified end to end with the real daemon binary and
`buf curl` over the token-protected loopback listener, and by `internal/daemon/repo_e2e_test.go`
(same flow, runs in `make check`).

## What landed

| Path | What |
|---|---|
| `internal/db` | `db.Open(ctx, path)`: modernc.org/sqlite (no cgo), WAL, `busy_timeout(5000)`, `foreign_keys(1)`, `synchronous(NORMAL)`, `_txlock=immediate`. Embedded, ordered migrations recorded in `schema_migrations` |
| `internal/db/migrations/0001_repos.sql` | `repos(id, path UNIQUE, name, registered_at)`, `STRICT` |
| `internal/store/repo` | `Store` interface, `*Git` implementation, git `Runner`, pure parsers, watch classification, scheduler/debouncer |
| `internal/store/repo/repotest` | `Fake` in-memory store that publishes the same bus events |
| `internal/api/repo.go` | Thin `RepoService` handler. Watch sends a snapshot, then events |
| `internal/daemon/stores.go` | Opens the DB, creates the bus, and starts the stores. `daemon.go` calls it and registers the route |
| `proto/codefoundry/v1/repo.proto` | Additive: `Repo.registered_at`, `Repo.error`, `Worktree.detached`, `GitStatus.{conflicted, base_ref, base_ahead, base_behind, error}`, `RepoEvent.snapshot` + `RepoSnapshot` |

## How to run it by hand

```sh
make build
CODE_FOUNDRY_HOME=/tmp/cf ./bin/code-foundry daemon --dev &
TOKEN=$(cat /tmp/cf/daemon.token); PORT=$(cat /tmp/cf/daemon.port)
buf curl --schema proto -H "Authorization: Bearer $TOKEN" \
  --data '{"path":"/path/to/any/dir/in/a/repo"}' \
  http://127.0.0.1:$PORT/codefoundry.v1.RepoService/Register
buf curl --schema proto -H "Authorization: Bearer $TOKEN" --data '{}' \
  http://127.0.0.1:$PORT/codefoundry.v1.RepoService/Watch      # streams until Ctrl-C
```

Observed `Watch` sequence for Register → CreateWorktree `e2e/demo` → `echo > dirty.txt` →
RemoveWorktree(force, delete_branch) → Unregister:

```
snapshot (0 repos)
repo_updated proj, 1 worktree          # first reconcile
worktree_updated proj main, clean, base origin/main
repo_updated proj, 2 worktrees         # CreateWorktree
worktree_updated e2e-demo, clean
worktree_updated e2e-demo, untracked=1 dirty   # fs watcher, ~300ms after the write
worktree_removed e2e-demo
repo_updated proj, 1 worktree
repo_removed_id
```

RemoveWorktree without `force` on the dirty worktree returned `failed_precondition` with
git's stderr in the message. `delete_branch` removed `e2e/demo`. A request without a token
got `unauthenticated`. With a Watch stream open, SIGTERM stopped the daemon in 0.02s.

This repository (`/Users/alex/projects/code-foundry`, registered read-only and then
unregistered before the first fetch) came back as: name `code-foundry`, default branch
`main` (fallback), 6 worktrees (main plus the agents' `.claude/worktrees/*`), with correct
branches, heads, and staged/modified/untracked counts. `github_slug`, upstream, and
`base_ref` were empty. That is correct: the repo has no remotes configured yet.

## Decisions

* **Repo identity** is `sha1(main worktree path)[:12]` (hex). The path is symlink-resolved,
  so `/tmp/x` and `/private/tmp/x` are the same repo. Register accepts any path inside the
  repo, including a file, a linked worktree, or the `.git` dir. It resolves the main
  worktree with `git rev-parse --path-format=absolute --git-common-dir`, taking the parent
  of `<common>/.git`. Bare repos and separate-git-dir layouts are rejected with
  `invalid_argument`. Register is idempotent.
* **Only registration is persisted.** Worktrees, default branch, slug, and status are
  re-derived from git on every start. On start the snapshot has every repo with no
  worktrees; each repo's first reconcile fills them in asynchronously (`repo_updated`).
* **Default branch** is `git symbolic-ref refs/remotes/origin/HEAD`, else `main` or `master`
  if a local or origin branch exists, else the main worktree's branch, else `main`. The
  third step goes beyond the spec, for repos whose trunk has another name and no
  origin/HEAD.
* **github_slug** comes from `git remote get-url origin`. It accepts scp-style ssh,
  `ssh://` (with or without a port, including `ssh.github.com:443`), `https` (with or
  without credentials, `.git`, or a trailing slash), and `git://`, on hosts `github.com`,
  `www.github.com`, and `ssh.github.com`. SSH host aliases (`git@github-work:o/n`) are
  **not** guessed and return empty. If that matters, 1c can fall back to
  `gh repo view --json nameWithOwner`.
* **Status** comes from one `git status --porcelain=v2 --branch -z` per worktree. That gives
  branch, head, upstream, ahead/behind against upstream (`# branch.ab`, the same numbers as
  `rev-list --left-right --count HEAD...@{u}`), and the counts. `X != '.'` counts as staged,
  `Y != '.'` as modified (one entry can be both), `u` as conflicted, and `?` as untracked
  (an untracked directory counts as one). `dirty` = any of those > 0. Ignored files are
  never counted.
* **Base comparison (addition).** `git rev-list --left-right --count HEAD...refs/remotes/origin/<default>`
  fills `base_ref`/`base_ahead`/`base_behind`. New feature branches have no upstream, so
  without this the sidebar couldn't show how far a worktree is ahead of or behind main.
  It is skipped when that ref is missing (no remote, or never fetched) or HEAD is unborn.
* **CreateWorktree**: `check-ref-format --branch` validates the name. If
  `refs/heads/<b>` exists, or `refs/remotes/origin/<b>` exists and no `base_ref` was
  given, it runs `git worktree add <path> <b>`. In the remote case, git's DWIM creates a
  local branch tracking `origin/<b>`, which is what you want for checking out a PR branch.
  Otherwise it runs `git worktree add --no-track -b <b> <path> <base>`. `base` defaults to
  `origin/<default>` when that ref exists (freshest after fetch), else `<default>`.
  **`--no-track` matters**: without it, branching from `origin/main` makes `origin/main`
  the upstream, so ahead/behind would be against main and `git push` would target main.
  *Later: a base of `origin/<b>` itself uses `--track` instead (pr-thread-commands.md).*
  The default path is `<repo parent>/<repo name>.worktrees/<branch with / → ->`, and git
  creates the parent dirs. *Superseded: worktrees now default to
  `~/.code-foundry/worktrees/<owner>/<repo>/<branch>` (`config-home.md`).* An explicit path must be absolute.
* **RemoveWorktree** refuses the main worktree (`invalid_argument`) and runs
  `git worktree remove [--force]`. If `delete_branch` is set it then runs `git branch -D`.
  If the branch delete fails, the worktree is still gone and the error says so.
  Unregister deletes the row only.
* **Error mapping**: `repo.ErrNotFound` → `not_found`, `ErrInvalidArgument` →
  `invalid_argument`, `ErrFailedPrecondition` (any failing mutating git command) →
  `failed_precondition`, ctx errors → `canceled`/`deadline_exceeded`, and anything else →
  `internal`. Git's stderr is always in the message.
* **Concurrency model.** Jobs are keyed `(reconcile, repo)` and `(status, repo, worktree path)`.
  The scheduler is a bounded pool (4 workers) over deduplicated keys and never runs one key
  on two workers at once. A request for a queued key coalesces. A request for a running key
  schedules exactly one rerun. A reconcile job is the only writer of its repo's metadata
  slot (`atomic.Pointer[repoMeta]`), worktree set, and watches. A status job is the only
  writer of its worktree's slot (`atomic.Pointer[Worktree]`). After a slot write, the job
  rebuilds the whole `Snapshot`, stores it in `atomic.Pointer[Snapshot]`, and publishes
  its events, all under one mutex. So events come out in order and each one matches the
  snapshot at publish time. RPCs that need fresh state (Register, CreateWorktree, Refresh,
  RemoveWorktree) request the jobs and wait for a run that *started after* the request.
* **Events** are one bus topic, `bus.Subscribe[repo.Event]`, with concrete types
  `RepoUpdated`, `RepoRemoved`, `WorktreeUpdated`, and `WorktreeRemoved`. One topic keeps
  them ordered for a subscriber. With four topics, a `WorktreeUpdated` could overtake the
  `RepoUpdated` that introduced its repo. `WorktreeUpdated` is published only when
  something other than `refreshed_at` changed, so polls and no-op fs events stay quiet.
  `RepoUpdated` is published when metadata or the worktree set changes.
* **Watch protocol (proto addition).** The first event is `snapshot` (all repos). After
  that, deltas follow. If the subscriber's 256-event buffer overflows, the handler sends a
  fresh `snapshot` instead of the missing deltas. A replay of N `repo_updated` events
  couldn't tell the client which repos vanished, which is why the dedicated snapshot event
  was added.
* **Runner**: every git call goes through `Runner.Run(ctx, dir, args...)`. `ExecRunner`
  sets:
  * `GIT_TERMINAL_PROMPT=0`.
  * `GIT_OPTIONAL_LOCKS=0` (see gotchas).
  * `LC_ALL=C`.
  * `GIT_PAGER=cat`.
  * Strips inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/... (a daemon started from a
    git hook would otherwise operate on the wrong repo).
  * Stdin is `/dev/null`, and `Setsid` means neither git nor ssh has a tty to prompt on,
    even under `daemon --dev` in a terminal.
  * `WaitDelay` 2s, so an orphaned ssh can't hold the pipes open.
  * A 30s default timeout when the ctx has no deadline. Fetch uses 2m; worktree
    add/remove use 5m.
  * Errors are `*GitError{Dir, Args, ExitCode, Stderr}`.
* **Fetch**: one goroutine fetches the repos sequentially (`git fetch --prune --quiet`,
  2m timeout each). The first round is 10s after start, so the first reconcile has learned
  the origin URL by then. After that it runs every `FetchInterval` (default 2m). Repos
  without an origin, or currently in error, are skipped. Failures are logged at warn and
  don't change state. A successful fetch requests a reconcile; the watcher would also see
  FETCH_HEAD. Tests disable it (`FetchInterval: -1`).
* **Backstop poll (addition).** Every `PollInterval` (default 30s), every worktree's status
  is refreshed, and every repo in error is reconciled. This covers what the
  non-recursive watcher can't see (below). Tests disable it. Since
  `repo-detail-cache.md`, "every worktree's status" always goes through `jobBase` first
  (one `rev-parse` of `origin/<default>` per repo), and the base ahead/behind is reused
  when neither HEAD nor that sha moved.
* **Daemon wiring**: `internal/daemon/stores.go` owns bus + DB + stores. `daemon.go` has
  `openStores` + `defer st.close()` + one route line. `daemon.go` also gained a
  **daemon-wide fix**: `http.Server.BaseContext` derives request contexts from a context
  that is cancelled *before* `Shutdown`. Previously an open server stream (Watch now,
  Attach and WatchIntents later) held shutdown for the full 5s timeout and was then
  force-closed. The e2e test asserts a prompt shutdown with Watch open; it fails without
  the fix.

## What triggers a refresh

fsnotify on macOS is kqueue. A watch on a directory reports entries created, removed, or
renamed in it, plus writes to the files directly inside it. It does not report anything
deeper. Watched directories per repo (`<common>` = `<main>/.git`):

| Directory | Entry → action |
|---|---|
| `<common>` | `HEAD`, `index` → status(main). `FETCH_HEAD`, `packed-refs`, `config`, `worktrees` → reconcile. `config.lock` created → reconcile too (see below) |
| `<common>/logs` | `HEAD` (reflog append: commit, reset, rebase, merge, pull, checkout) → status(main) |
| `<common>/refs/remotes/origin` | anything → base(repo), which then runs status(all worktrees) (push or fetch moved a remote-tracking ref) |
| `<common>/worktrees` | entry created, removed, or renamed → reconcile (`git worktree add/remove/prune` from anywhere) |
| `<common>/worktrees/<name>` | `HEAD`, `index` → status(that worktree) |
| `<common>/worktrees/<name>/logs` | `HEAD` → status(that worktree) |
| each worktree root | any entry except `.git` → status(that worktree) |
| a watched dir itself removed or renamed | → reconcile (worktree deleted by hand, repo moved) |

Always ignored: names ending in `.lock` (except `<common>/config.lock` being created:
kqueue was seen to drop the rename of `config.lock` onto `config`, so a remote removal
went unnoticed on a CI runner; the lock's creation is a reliable directory-entry event
and the debounce window outlasts git's rewrite), and Chmod-only (attribute) events. Each job key is
debounced: the first event arms a 300ms timer, later events in the window are absorbed, and
the job then fires once. Latency stays bounded under a continuous stream of events.
`classify()` in `watch.go` is the source of truth and has a table test.
`refs/remotes/origin`, `worktrees/`, and `logs/` may not exist yet. They are added at the
next reconcile, which their creation triggers through the parent's events (`FETCH_HEAD`,
`worktrees`).

**Not seen by the watcher** (covered by the 30s poll, or an explicit `Refresh`):

* Edits to existing files below the top level of a worktree. That is most source edits.
  Creating, deleting, or renaming nested files is also invisible. `git add` and
  `git commit` *are* seen (index, reflog).
* Remote-tracking refs with a `/` in their name (`origin/alex/foo` lives in a
  subdirectory) when only a push moves them. A fetch is still seen via FETCH_HEAD.
* Local branch refs moving without HEAD moving (`git branch -f other`). They don't affect
  any worktree's status anyway.

## Gotchas

* **`git status` writes the index.** By default it takes `index.lock` and rewrites
  `.git/index` to refresh stat info. Our own watcher sees that and refreshes again,
  forever. `GIT_OPTIONAL_LOCKS=0` stops it (verified: removing it makes
  `TestNoSelfTriggeredRefreshLoop` fail with index REMOVE/CREATE events).
* **Reading the index fires Chmod.** kqueue reports NOTE_ATTRIB (fsnotify `Chmod`) on
  `.git/index` when git merely *reads* it (atime), so every status triggered the next one
  (~17 extra runs/s observed). Chmod-only events are ignored everywhere.
* **kqueue costs one fd per watched file.** fsnotify's kqueue backend opens every file in a
  watched directory (subdirectories are opened too, but only watched for delete/rename).
  A worktree root with N top-level entries costs about N fds. Go raises the soft
  RLIMIT_NOFILE to the hard limit at startup, so this is fine for dozens of worktrees.
  It is the reason the watcher is not recursive. FSEvents would be the scalable answer,
  but fsnotify doesn't use it on darwin.
* **macOS temp paths are symlinks.** `t.TempDir()` lives under `/var/folders/...` and git
  reports `/private/var/...`. Every path is resolved with `filepath.EvalSymlinks` before it
  becomes an id or a map key, both on input and on `git worktree list` output.
* **`git worktree list --porcelain -z`** needs git ≥ 2.36. Local git is 2.52; Xcode's git
  on current macOS is newer than 2.36.
* **Prunable worktrees** (directory deleted without `git worktree remove`) are left out
  of the list. They are not pruned; nothing on disk changes unless the user asks.
* **A repo whose directory disappears** keeps its row. Its reconcile sets `Repo.error`, and
  its worktrees and watches are dropped. The poll retries it, and it recovers when the
  directory comes back (`TestMissingRepoReportsErrorAndRecovers`).
* **modernc.org/sqlite pragmas** must go in the DSN as `_pragma=` so they apply to *every*
  pooled connection. `PRAGMA foreign_keys=ON` on one connection would silently not hold
  on the others. The DB test checks three connections.
* Test helpers isolate git with `GIT_CONFIG_GLOBAL=<temp file>` and `GIT_CONFIG_NOSYSTEM=1`,
  so a developer's signing, hooks, or fsmonitor config can't break or slow the tests.
  The store's runner inherits the test's environment.

## For other steps

**1e (GUI sidebar)**

* Open `RepoService.Watch` once. Replace all repo state on every `snapshot` event, and
  apply the other events in order. `repo_updated` replaces a repo *including* its
  worktree list; `worktree_updated` replaces one worktree. On stream error, reconnect
  (the next stream starts with a snapshot). You do not need to call `List` first.
* Worktrees come main first, then sorted by path. Repos are sorted by name, then path.
* `status.refreshed_at` unset means status is not known yet: a worktree seeded by
  reconcile shows branch and head from `git worktree list` until its first status job.
  `status.error` / `repo.error` non-empty means stale or broken; show it.
* Use `base_ahead`/`base_behind` (vs `origin/<default>`) for "N commits ahead of main"
  on feature branches. `ahead`/`behind` are against the upstream and are 0 when there is
  none. `detached` worktrees have an empty `branch`.
* Dirty counts for nested edits can lag by up to 30s (see the table above). A future
  session store should call `Refresh` (or publish an intent that does) when a Claude
  session goes idle in a worktree.

**1c (gh store)**

* Add tables as `internal/db/migrations/0002_<name>.sql`. Never edit 0001. `LoadMigrations`
  fails on duplicate version numbers, so a numbering clash between parallel branches fails
  loudly at startup and in `go test ./internal/db`.
* Use the shared `*sql.DB` from `daemon.stores` (add a field and one line in `openStores`).
  Write transactions are `BEGIN IMMEDIATE` (`_txlock=immediate`) with a 5s busy timeout.
* Get repos and slugs from `repo.Store.Snapshot()` and `bus.Subscribe[repo.Event]`. Poll
  only repos with a non-empty `GitHubSlug`, and react to `RepoUpdated`/`RepoRemoved`.
  `repotest.New(bus)` is a fake for tests: `Put`/`UpdateWorktree` publish events.
* The repo store does not resolve SSH host aliases. If a slug is empty but the remote
  is GitHub, `gh repo view --json nameWithOwner` from the main worktree path is the
  fallback.

## Deviations from the brief

* Extra proto fields, all additive: `registered_at`, `Repo.error`, `Worktree.detached`,
  `GitStatus.{conflicted, base_ref, base_ahead, base_behind, error}`, and
  `RepoEvent.snapshot`/`RepoSnapshot`.
* ahead/behind vs upstream come from `status --porcelain=v2 --branch` (same numbers, one
  fewer process). `git rev-list --left-right --count` is used for the base comparison.
* Added the 30s backstop poll and the "main branch of the main worktree" default-branch
  fallback.
* `daemon.go` changes beyond the route line: the `openStores` call and `defer`, plus the
  `BaseContext` shutdown fix described above.
