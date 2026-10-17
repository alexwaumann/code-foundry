# One FSEvents stream replaces the kqueue watcher

Status: done. `make check` is green. Verified end to end with a scratch daemon
(`CODE_FOUNDRY_HOME` in a temp dir, `daemon --dev`) on a scratch repo under `$HOME` with a
bare origin, a managed worktree, and a hand-made worktree outside both the project and
the managed root.

PR 2 of three. PR 1 (`cf/git-activity-tiers`, live/idle poll and fetch tiers) had not
merged when this was written, so this PR only changes `DefaultPollInterval` from 30 s to
2 min. When PR 1 lands, its live-tier poll becomes 2 min and the idle tier stays 10 min.

## Why

fsnotify on macOS is kqueue: one watch per directory, non-recursive, one fd per entry
in a watched directory. Edits to nested files (most source edits) were only seen by the
30 s poll, and the watcher could not go recursive without an fd per file.

## What changed

| File | Change |
|---|---|
| `internal/store/project/fsevents.go` (new) | `fsWatcher`: one FSEvents stream per store. `run` owns the stream (create, start, stop: the only cgo calls). `dispatch` drains the batches and calls `Git.onEvents`. `sync` asks `run` to make the stream match `streamPaths()` and waits. `resolveMissing` |
| `internal/store/project/watch.go` | `classify` takes the package's own `op` (decoded from FSEvents flags by `opsOf`) instead of `fsnotify.Op`. New: `route` (path → nearest known directory → `classify`), `eventKeys` (one event → job keys, rescans included), `keysFor`, `streamRoots` (minimal non-nested path set), `recursive`, `wkPlainRoot`. `desiredWatches` is now the routing table |
| `internal/store/project/store.go` | `watches` → `routes` (the routing table; nothing is "added" any more, so directories that do not exist yet are routed too). `reconcile` replaces the project's routes and calls `fs.sync` when they changed; `Unregister` drops them and syncs. `watchLoop`, `keysFor(fsnotify.Event)`, `syncWatches` gone. `DefaultPollInterval` 2 min. `runJob` logs one `job done` debug line per job (kind, worktree, duration) |
| `internal/store/project/sched.go` | `jobKind.String()` |
| `internal/store/project/nogit.go` | comment: a plain project is in the stream now |
| `CLAUDE.md`, `docs/ARCHITECTURE.md` | cgo line names both owners; project store paragraph |
| `go.mod` | `github.com/fsnotify/fsevents v0.2.0`. fsnotify stays: `internal/store/settings` and `internal/store/thread` (transcripts) still use it |

## The stream

* **One per store** (one per daemon). Flags: `FileEvents` (a path names the file),
  `NoDefer` (the first event after a quiet period is delivered at once), `WatchRoot`
  (`RootChanged` when a root itself moves). Latency 250 ms. Since = now, no history.
* **Paths** (`streamRoots`): the minimal non-nested set of the managed worktree root, every
  registered project's directory (git projects without error, and projects without
  git), and every worktree `git worktree list` reports. A worktree inside the managed
  root or inside a project directory adds nothing; a hand-made one elsewhere adds its
  root. Paths are sorted so the set compares equal across reconciles.
* **Recreated** when that set changes. `reconcile` (project registered, worktree listed or
  gone, project in error or recovered) and `Unregister` call `fs.sync`, which recomputes
  the set and, if it differs, starts a new stream before stopping the old one: no gap,
  and the overlap can only deliver an event twice, which the debouncer absorbs.
* **The managed root may not exist yet** (fresh install). FSEvents accepts a missing path
  and reports `RootChanged` when it appears. It is resolved once at start with
  `resolveMissing` (the nearest existing ancestor's symlinks), because FSEvents reports
  real paths (`/private/var/...`).
* **A stream that fails to start** is logged at warn and retried at the next `sync`; the
  poll keeps everything correct meanwhile.

### Goroutines and cgo

`run` is the only goroutine that calls into the fsevents package's cgo (create, start,
stop), as the terminal actor is for libghostty-vt. The package's callback runs on a
dispatch-queue thread and does a **blocking** send of each batch on `EventStream.Events`.
If the goroutine that calls `Stop` also read that channel, a `Stop` that waits for an
in-flight callback could deadlock against it. So every stream shares one buffered
channel (256 batches) that `dispatch` drains, and `dispatch` never waits on `run`. It
takes `Git.mu` for reading (the routing table) and calls `deb.trigger`, neither of which
waits on `run`. `sync` is never called with `Git.mu` held. On `Close`, `run` stops the
stream and then closes `stopped`, and `dispatch` keeps draining until then.

The race detector is clean (`go test -race`): the callback only writes the
`EventStream`'s own `EventID` and sends on the channel, and the routing table is only read
under `Git.mu`.

## What triggers a refresh

Every event path is routed by `route` (`watch.go`): if the path is a known directory and
the event removed or renamed it, reconcile. Otherwise the **nearest known directory above
the path** decides, through `classify(kind, base name, op)`, which is still the single
source of truth. Nearest wins, so `<main>/.git/HEAD` belongs to the common dir, not the
main worktree root, and a file in a worktree nested inside the main checkout
(`.claude/worktrees/x`) belongs to the nested worktree. A path deeper than a direct entry
counts only below a recursive kind (worktree roots and `refs/remotes/origin`). A path
with no known directory above it is ignored.

Known directories per git project (`<common>` = `<main>/.git`):

| Directory | Entry → action |
|---|---|
| `<common>` | `HEAD`, `index` → status(main). `FETCH_HEAD`, `packed-refs`, `config`, `worktrees` → reconcile. `config.lock` created → reconcile. Operation markers (`rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`) → status(main). Anything deeper (`objects/`, `refs/heads/`, `rebase-merge/*`, fsmonitor cookies) → nothing |
| `<common>/logs` | `HEAD` → status(main). Deeper (`logs/refs/...`) → nothing |
| `<common>/refs/remotes/origin` | **anything at any depth** → base(project), then status(all) |
| `<common>/worktrees` | entry created, removed, or renamed → reconcile |
| `<common>/worktrees/<name>` | `HEAD`, `index`, operation markers → status(that worktree). An admin dir not yet reconciled is ignored; its creation in `worktrees/` reconciles |
| `<common>/worktrees/<name>/logs` | `HEAD` → status(that worktree) |
| each worktree root | **anything at any depth** except the root's `.git` → status(that worktree) |
| a project without git (its directory) | `.git` created or renamed in → reconcile (`git init` outside the app). Nothing else |
| a known directory itself removed or renamed | → reconcile (worktree deleted by hand, project moved) |
| `MustScanSubDirs` / `KernelDropped` / `UserDropped` / `RootChanged` / `Mount` / `Unmount` | → reconcile every project with a known directory at, above, or below the event path |

Filters: `.lock` names are ignored in the git directories (except `<common>/config.lock`
created), but **not in worktrees** any more: there a `.lock` file is the user's
(`Cargo.lock`, `yarn.lock`, `flake.lock`), and the old rule hid edits to them. Git never
writes lock files into a worktree. Attribute-only events (only `ItemInodeMetaMod`,
`ItemXattrMod`, `ItemFinderInfoMod`, `ItemChangeOwner`) are ignored. An event with no
change flag the decoder knows counts as a write.

Each job key is still debounced by the 300 ms per-key debouncer, and the scheduler is
unchanged; the stream only feeds `deb.trigger`.

**Newly seen** (were poll-only): edits, creations, deletions, and renames of nested files
in every worktree; remote-tracking refs with a `/` in the name moved by a push; `git init`
in a project without git.

**Still not seen** (covered by the 2 min poll or `Refresh`):

* Refs in the reftable backend (`<common>/reftable/` is below the common dir, not
  routed). Rare; the poll re-resolves the base each round.
* Local branch refs moving without HEAD moving (`git branch -f other`). They do not
  change any worktree's status.
* A project in error has no routes until the poll's reconcile recovers it.

## Measurements

Scratch daemon (`--dev` debug log), Apple silicon, small repo:

| Action | Result |
|---|---|
| Append to `src/deep/er/x.go` in the main checkout | event 13 ms after the write; status done 323 ms after (300 ms of it is the debounce) |
| Same in the managed worktree / the hand-made worktree outside both roots | status done 327 ms / 322 ms after the write |
| `git commit -a` in the managed worktree | `worktrees/feat/logs/HEAD` → status(feat) |
| push from another clone, then `git fetch` in the project | `FETCH_HEAD` → reconcile → base → status(all); `refs/remotes/origin/main` → base |
| `git worktree add ../hand2` (outside the roots) | `worktrees/hand2` → reconcile → stream recreated with `hand2` 354 ms after the command started; a nested edit in `hand2` then refreshed it |
| `git worktree remove --force hand2` | `RootChanged` on `hand2` (a stream root) → reconcile → stream recreated without it |
| untar 2000 files into `proj/node_modules` (~0.6 s) | 4082 events in 144 batches, **3 status runs** |
| open fds (`lsof -p`) | 65 before the scenario, 65 after (two stream recreations and the burst included) |

`TestStreamBurstIsBounded` (2000 files, 50 ms test debounce): 4 status runs.

## Gotchas

* **FSEvents item flags are cumulative.** An event reports every flag the item collected
  while the kernel kept it in its cache, not only what just happened: a `chmod` of a file
  written earlier came as `Created Meta Modified Owner Xattr`. So "attribute-only" is
  rare, and `Removed`/`Renamed` on a known directory can be stale. Both mistakes only cost
  an extra (debounced, idempotent) job, never a missed one. A test row covers
  `config.lock` with `Created|Removed|Modified`.
* **`git status` emits nothing** with `GIT_OPTIONAL_LOCKS=0` (verified with a probe
  program). Without it, it writes `index.lock` and renames it onto `index`, and the stream
  sees that: removing the variable makes `TestNoSelfTriggeredRefreshLoop` fail with 4
  extra status runs per second. FSEvents does not report reads, so the kqueue
  "reading the index fires Chmod" loop cannot happen.
* **Bursts arrive in chunks** of up to about 32 events every ~30 ms, despite the 250 ms
  latency. `onEvents` dedupes keys per batch and logs one debug line per key per batch,
  so a 2000-file untar logs 144 lines at debug level, not one per file.
* **The fsevents package does not name `ItemCloned`** (`0x400000`). A `cp -c` (APFS clone)
  event may carry only `ItemIsFile | ItemCloned`. `opsOf` treats it as a create, and any
  flagless change as a write.
* **The package's callback blocks on a full channel**, hence the two-goroutine design
  above. It also sets a finalizer that stops a stream nobody stopped; `run` always stops
  its streams explicitly.
* **Gitignored churn still runs status.** A dev server writing `.next/` or a build writing
  `bin/` refreshes that worktree at most once per debounce window while it writes. Status
  only publishes when something changed, so the cost is git processes, not events.

## Left out

* Filtering events under gitignored directories (`git check-ignore` or a per-worktree
  ignore cache) before requesting status. The burst numbers did not need it; worth
  revisiting if a long-running watcher process (dev server) shows up in profiles.
* Routing `<common>/reftable/` changes.
