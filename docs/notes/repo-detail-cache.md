# Repo detail cache: reuse HEAD-only git results

> **Superseded (2026-10-10):** `repo.register` (`code-foundry repo register --path`) was removed. Add a folder with `code-foundry repo add <folder>` on the CLI, or the Add Project dialog (`repo.add`) in the app; see `add-project-remove-register.md`. Mentions below are historical.

Status: done. `make check` is green. Verified end to end against a scratch daemon
(`CODE_FOUNDRY_HOME` in a temp dir) with a scratch repo and a bare origin.

## Problem

While the overview page is open, the GUI renews `GetWorktreeDetail` every 5 minutes, so
the worktree stays inside `DetailWatch`. Every status job for it (fs events, the 30s
backstop poll, Refresh) was followed by a full detail recompute: up to 7 git commands.
Every status job also ran `rev-list --left-right --count HEAD...origin/<default>`.
Most of that work depends only on two shas:

| Command | Depends on |
|---|---|
| `merge-base`, committed `diff --name-status <mb> HEAD`, `log <base>..HEAD`, `rev-list --count` | (HEAD, base) |
| `diff --numstat <mb> HEAD` (clean worktree) | (HEAD, base) |
| uncommitted `diff --name-status HEAD`, `ls-files --others`, `diff --numstat <mb>` (dirty) | the working tree |
| status's base `rev-list --left-right --count` | (HEAD, base) |

## What changed

| File | Change |
|---|---|
| `internal/store/repo/base.go` (new) | `jobBase`: resolves `origin/<default>` to a sha once per repo and stores it in `repoState.base`. `baseCounts`: status's ahead/behind, memoized per worktree in `wtSlot.base` |
| `detail.go` | `headPart` cache keyed by `headKey{head sha, BaseRef, base sha}` in `detailState.heads`. `fillDetail` reuses it and runs only the working-tree commands; a clean worktree reuses its cached file list too. `detailBase` returns the ref and its sha |
| `store.go` | reconcile, the `refs/remotes/origin` watch, and the poll request `jobBase` instead of a status refresh of every worktree; `jobBase` requests that refresh itself. `refresh()` waits reconcile, then base, then statuses. `status()` uses `baseCounts` and no longer rebuilds the snapshot when nothing changed |
| `sched.go`, `watch.go` | the `jobBase` kind; comments |

### Base sha resolution

`jobBase(repo)` runs `git rev-parse --verify --quiet refs/remotes/origin/<default>^{commit}`,
stores `{ref, sha}`, and then always requests a status refresh of every worktree. It runs
in every place that used to request "status of every worktree":

* **After each reconcile.** A fetch (ours or the user's) writes FETCH_HEAD, which triggers
  a reconcile, and our fetch loop requests one too. packed-refs and config changes also
  trigger one. A fetch that moves origin/<default> therefore always re-resolves.
* **Any change under `refs/remotes/origin`** (a push or fetch moved a loose ref).
* **Every backstop poll** (30s). This covers ref moves the watcher cannot see: a default
  branch with a `/` in its name lives in a subdirectory, and repos using the reftable
  backend have no loose refs. These cases are no worse than before, since the poll
  refreshed status every 30s already.

Why not the alternatives:

* **One `rev-parse` per status job** would be just as correct but saves nothing: it
  replaces one process (`rev-list`) with another. One per repo per round is shared by all
  of the repo's worktrees.
* **Reading the loose ref file** is wrong once refs are packed (and with reftable).
  `rev-parse` handles every backend.
* **Resolving only in reconcile** (moving the remote-refs watch to reconcile) would cost
  3–4 extra processes per push and would miss reftable pushes until the next fetch.

`jobBase` is the only writer of `repoState.base`. On a failure other than exit 1 ("no
such ref"), it keeps the previous value, so a transient error does not drop the base
comparison from every worktree.

Ordering: a status job that runs before `jobBase` has stored a new sha uses the old one.
Its result is right for that sha, and `jobBase` requests status for every worktree after
the store, so the next run uses the new sha. `Refresh`, `Register`, and `CreateWorktree`
wait for reconcile, then `jobBase`, then the statuses, so they still return fresh
ahead/behind.

### Status: base ahead/behind

`baseCounts` reuses the slot's memo `{head, ref, sha, ahead, behind}` when HEAD (from this
run's `git status`) and the repo's base `{ref, sha}` both match. Otherwise it runs
`rev-list --left-right --count <head>...<base sha>`, using shas rather than names, so the
counts are exactly a function of the key. A failure clears the memo and leaves `BaseRef`
empty, as before. Only the status job writes `wtSlot.base`.

### Detail: the head part

* The key is `(HEAD sha from the slot, BaseRef, base sha)`. BaseRef is part of it because
  `origin/main` and a local `main` can share a sha but show differently.
* The base is the repo's resolved `origin/<default>` when it exists. Otherwise it is the
  local default branch when the worktree is on another branch, resolved per detail with
  `rev-parse --verify --quiet refs/heads/<def>^{commit}`. That is one process, the same
  `refExists` call the old code made. An unborn HEAD has no base.
* All commands name commits by sha: `merge-base <head> <base>`,
  `diff --name-status <mb> <head>`, `log <base>..<head>`, `rev-list --count <base>..<head>`,
  and the uncommitted `diff --name-status <head>`. So a cached head part is exactly what
  its key produces, even when HEAD moves while the job runs. The status job that sees the
  move schedules another detail.
* `merge-base` exiting 1 (no merge base: unrelated histories, or past a shallow boundary)
  is git's answer and is cached as "no merge base". Any other failure is an error: the
  detail keeps its previous content, sets `Error`, and caches nothing.
* **Clean worktree.** The file list is `mergeFiles(committed, numstat <mb> <head>)`. It is
  computed once per key and stored in the head part, so an unchanged clean worktree runs
  **no git at all**, including after a dirty → clean transition (one numstat, then none).
  With no base (or no merge base) a clean worktree has no files and runs nothing.
* **Dirty worktree.** The cached head part replaces 4 commands. The 3 working-tree
  commands run every time, because the working tree can change without any key change.
* Single writer: `detailState.heads[k]` and `cache[k]` are written only by `jobDetail(k)`.
  The head part is immutable once stored; adding the clean file list stores a copy.
  Cached details share `Log` and clean `Files` slices, which nobody mutates.
* Events are unchanged. `WorktreeDetailUpdated` fires only when `sameDetail` says
  something changed. A fetch that moves origin/main without changing the merge base, files,
  or log recomputes the head part (the key changed) but publishes nothing.

### Unchanged status no longer rebuilds the snapshot (item 3)

`status()` used to call `g.commit(nil)` when nothing but `RefreshedAt` changed. That
rebuilt and re-sorted every repo and worktree only to bump one timestamp, on every poll,
for every worktree. Who reads `Status.RefreshedAt` without an event:

* **GUI:** `api/repo.ts` maps it to `refreshedAtMs`, and no component reads it.
* **CLI:** nothing prints it (only `--json` output of the whole message would show it).
* **API:** `List`, `Get`, and the Watch/EventService snapshots copy whatever the snapshot
  holds.
* **In the store:** `detail()` checks `RefreshedAt.IsZero()` ("has status run?"), but reads
  the slot, not the snapshot.

Decision: **drop the rebuild, except for the first status of a worktree.** An unset
`refreshed_at` means "status not known yet" (phase 1b's contract to the GUI), and a clean
worktree with no upstream and no base has a status equal to the zero value, so its first
refresh would otherwise never reach the snapshot
(`TestFirstStatusPublishesRefreshedAt`). The slot still records every refresh. The
snapshot's `refreshed_at` is now the time of the last status that changed something (or
that a later commit for any reason picked up). It is not "last checked". A future feature
that wants "checked N seconds ago" should publish it explicitly rather than rely on this
field.

## Measurements

### Git commands per recompute

One round = `jobBase` + the worktree's status job + its detail job, the sequence a poll
or fs event runs for a watched worktree. Counted with a recording `Runner`
(`TestDetailCache`), on the fixture repo: a feature worktree one commit ahead of
origin/main.

| Case | Before (status + detail) | After (base + status + detail) |
|---|---|---|
| clean, key unchanged | 2 + 5 = **7** | 1 + 1 + 0 = **2** |
| dirty, key unchanged | 2 + 7 = **9** | 1 + 1 + 3 = **5** |
| HEAD moved (commit), clean | 2 + 5 = 7 | 1 + 2 + 5 = 8 |
| origin/main moved (fetch), clean | 2 + 5 = 7 | 1 + 2 + 5 = 8 |
| dirty → clean, key unchanged | 2 + 5 = 7 | 1 + 1 + 1, then 1 + 1 + 0 |
| unborn branch | 1 + 3 = 4 | 1 + 1 + 3 = 5 |
| no base (no origin, main worktree), clean | 2 + 1 = 3 | 1 + 1 + 0 = 2 |
| local `main` as base (no origin), unchanged | 2 + 6 = 8 | 1 + 1 + 1 = 3 |

(Without origin/<default>, the old status still ran the base `rev-list`, which failed.
The old clean detail with no base ran `diff --numstat HEAD HEAD`.)

The `jobBase` `rev-parse` is per repo per round, not per worktree. A repo with N
worktrees and no overview open goes from 2N to N + 1 processes per poll. The rows where
"after" is one higher (a key changed, an unborn branch) pay the per-repo `rev-parse` in a
round that reuses nothing.

### Timing on a large repo

`git clone --filter=blob:none https://github.com/neovim/neovim` (38,394 commits, 3,928
files, no commit-graph). Worktree `bench`: branched from `origin/master~200` plus 2
commits touching 2 files, so it is 2 ahead and 283 behind. The median of 9 rounds of
`resolveBase` + `status` + `detail`, run in process with the real `ExecRunner` (a
temporary test, not committed). "Cold" drops the head part and the status memo before
each round, which reproduces the old command set plus one `rev-parse`:

| Case | Cold (≈ before) | Warm (after) |
|---|---|---|
| clean | 8 git, **65 ms** (62–68) | 2 git, **20 ms** (19–21) |
| dirty (one untracked file in `src/`) | 10 git, **88 ms** (87–91) | 5 git, **49 ms** (48–53) |

The old code did not run the `rev-parse` (~6 ms), so the true before is about 59 ms clean
and 82 ms dirty.

Per command (mean of 10 runs, same worktree, warm fs cache): `status` 14.6 ms,
`rev-parse` 5.8, `rev-list --left-right` 8.0, `merge-base` 7.4, committed name-status 6.2,
`log` 9.0, `rev-list --count` 7.6, clean numstat 7.1, uncommitted name-status 9.0,
`ls-files --others` 11.4, worktree numstat 10.1. With a warm cache, process start
(~5 ms) dominates. The walks grow with distance: `rev-list --left-right --count` for a
branch 6,705 commits behind took 62–77 ms (with or without commit-graph), versus
18–26 ms at 283 behind. Before this change, every status job of such a worktree paid
that walk, and every detail recompute paid it twice more (`log`, `rev-list --count`).
Phase 3a's ~200 ms per working-tree scan on neovim was with a cold fs cache; those scans
still run for dirty worktrees.

## End to end

Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/rdc-e2e/home ./bin/code-foundry daemon --dev`),
repo registered with `code-foundry repo.register`, worktree created with
`repo.worktree.new --branch feat/e2e`, a commit in it, then `GetWorktreeDetail` over
Connect JSON (curl with the bearer token). Debug log lines, paths trimmed:

```
19:52:07.003 worktree detail head=46aea5c59947 clean=true  git_runs=5   # first call
19:52:07.241 base counts reused head=46aea5c59947 base=80b1734aa00d
19:52:07.241 worktree detail head=46aea5c59947 clean=true  git_runs=0
19:52:12.860 worktree detail head=46aea5c59947 clean=false git_runs=3   # notes.md (watcher)
19:52:26.646 worktree detail head=46aea5c59947 clean=false git_runs=3   # sub/x.txt edit (poll)
19:52:57.854 fs event kind=remote-refs action=status-all                # git fetch after a push
19:52:58.174 base resolved ref=origin/main sha=753c0bec7aed...
19:52:58.238 worktree detail head=46aea5c59947 clean=false git_runs=7   # new key
19:52:58.254 worktree detail head=46aea5c59947 clean=false git_runs=3
19:53:10.805 worktree detail head=46aea5c59947 clean=true  git_runs=1   # cleaned up
19:53:26.623 worktree detail head=46aea5c59947 clean=true  git_runs=0
```

Each change showed up in `GetWorktreeDetail`:

* the untracked `notes.md` (`?`, +2)
* the nested `sub/x.txt` edit (`M`, +1 −1, after the 30s poll)
* after the fetch, `ListRepos` showed `baseBehind: 1` on both worktrees
* after cleanup, the files went back to `feature.go` only

The log had no warnings or errors.

## Gotchas

* A detail job and a status job for the same worktree run concurrently: they are
  different keys. The detail reads `wt` from the slot and the base from the repo. Because
  every command uses explicit shas, a mismatch between the two is self-consistent for its
  key, and the status job that saw the newer state schedules another detail.
* The fetch test case expects **no** `WorktreeDetailUpdated`: moving origin/main without
  changing the merge base leaves the detail identical. Only the status changes
  (`BaseBehind`).
* At daemon start, an fs-triggered status job could in principle run before the repo's
  first `jobBase`. It would report no base comparison until `jobBase` finishes and
  refreshes it again. Register and Refresh order the jobs, so tests and RPCs never see
  this.
* The head cache is not evicted when the watch window lapses; it is one small struct per
  worktree ever viewed, and it is dropped with the detail when the worktree disappears.
* `go test` for packages that link libghostty-vt needs `PKG_CONFIG_PATH`; `make check` sets
  it. A fresh agent worktree has no `third_party/ghostty-vt` (it is ignored). I copied the
  built one in and rewrote the `prefix=` lines of its `.pc` files.
