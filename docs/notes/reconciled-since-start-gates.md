# Gates that wait for the first live reconcile

Since the SQLite snapshot cache (docs/notes/perf-project-gitmeta-sqlite-cache.md) the
project store's first snapshot after a start is the last run's: default branch, GitHub
slug, remotes and every worktree's branch are known at once, before any git command has
run. Several consumers read "the default branch is known" (or "the project lists
worktrees") as "this project has been reconciled since the start". On the cached snapshot
those gates passed on stale data.

## What went wrong (reproduced)

`internal/daemon/reconciled_gates_test.go` runs the real project store across a restart.
The first run caches a project (default branch main) with a worktree on feat/a; while the
daemon is down the worktree switches to feat/b and origin's HEAD moves to trunk. On the
next start, with git held back so no reconcile has run:

- Branch links (`threadBranches`): the thread was linked to feat/a's pull request. Links
  persist, so the wrong link outlived the reconcile.
- Settling old links (`defaultBranchOf`): a link without a head whose pull request's head
  is trunk (the new default) was settled against main: kept with head trunk instead of
  dropped. Settling is once per link, so that is permanent.
- GitHub notifications (`projectsSettled`): reported settled, so the first evaluation ran
  on the cached slugs. A slug that changed while down flips a card's start-action
  project after the reconcile, which brings a dismissed card back (the reason the gate
  exists).

Underneath, a fourth: the first live reconcile kept a hydrated worktree slot as it was
(reconcile only seeds new slots; the status job writes Branch), so even its own snapshot
still said feat/a until that worktree's `git status` ran. Gating on "reconciled" alone
would not have been enough.

## Decision

- `project.Project.Cached` (store-only, not in proto: no client needs it; the GUI keeps
  showing the cached snapshot immediately). Set for every project hydrated from the cache
  at Start; cleared by the project's first successful reconcile, in the snapshot that
  carries what it read. A failed reconcile leaves it set (its Error says why). A project
  registered this run is never Cached. Its zero value means live, so fakes and snapshot
  literals in tests need no change.
- The first reconcile reseeds a hydrated slot whose listing disagrees on Branch, Head or
  Detached (`staleHydrated`), the same way it seeds a new slot: a running status job on
  the old slot sees the slot replaced and drops its result. The cached status goes with
  it (it described another HEAD) until the new slot's status runs. A slot that agrees is
  kept, cached status and all, so a start where nothing changed looks as before.
- Gates:
  - `threadBranches` skips a Cached project (as it skips one with no default branch).
  - `defaultBranchOf` answers unknown while any project is Cached without an error: a
    cached project's slug may have changed, so which project owns a slug is unknown
    too, not only its default branch.
  - `projectsSettled` waits for every Cached project (git or not: a plain folder may
    have become git while down) and, as before, a git project with no default branch.
  - Same assumption, same fix, in the thread store's startup passes:
    `backfillBranch` (pre-0027 rows), `fillPaths` (pre-0049 rows) and
    `setupProjectsListed` (cleanup of a Create the daemon died during: the cache may
    predate the worktree it added) now wait for a project that is Cached. Their existing
    time limits still apply.
- Errors do not block: a Cached project whose reconcile failed counts as settled for
  notifications and does not hold `defaultBranchOf` for other slugs, as before the cache
  (an errored project then had no slug or default branch). It contributes no branch
  links and settles nothing for its own slug, also as before.

## Cost

These decisions are back to pre-cache timing: they wait for each project's first
reconcile, which is one `git worktree list` per project plus direct metadata reads
(about 7 ms a project in BenchmarkC6Reconcile5Projects), scheduled at Start. The
branch-link pass already debounces 200 ms, and the notifications keep their one-minute
ceiling (`githubProjectsSettle`). Nothing the GUI shows waits.

## Gotchas

- Do not read `DefaultBranch != ""` or `len(Worktrees) > 0` as "reconciled this run".
  Check `Cached` too.
- `hydrated` (publish one ProjectUpdated after the first reconcile) and `cached` are
  separate on `projectState`: the first clears on any reconcile, the second only on a
  successful one, so a project that keeps failing does not republish on every poll.
- A project with an error keeps its cached DefaultBranch and GitHubSlug in the snapshot
  (reconcile starts from the previous meta). Consumers must not take those as live while
  `Cached` is set.
