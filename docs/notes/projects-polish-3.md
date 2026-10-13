# Projects polish 3: safe worktree cleanup

PR 3 of three for the Projects page (sketch variant A, `/tmp/cf-projects-sketch`,
`?always=1`, `?menu=project`). Goal: reclaim the disk space of worktrees whose work is
already in the default branch, without ever touching a branch.

## The rule

A worktree is cleanable when all hold:

- git (`repo.MergedCleanReason`, `internal/store/repo/cleanup.go`, table-tested): not the
  main worktree; on a branch (not detached); its status has been read and has no error; no
  staged, modified, untracked or conflicted entries; `status.base_ref` is set and
  `base_ahead == 0` (every commit on HEAD is in `origin/<default>`).
- nothing holds it (`cleanupHold`, `internal/daemon/cleanup.go`, table-tested): no live
  thread (state not disconnected) whose cwd is the worktree or inside it; no terminal that
  has not exited whose `worktree` label is the worktree or whose cwd is in it; not a
  workspace member.

## Boundary choice

The repo store cannot see sessions, terminals or workspaces, and a `cleanable` flag joined
into the repo snapshot in `internal/api` would go stale: nothing republishes a worktree when
a thread exits or a shell closes. So:

- the proto `Worktree` carries only the git half, `merged_clean` (from the repo store's
  `Worktree.MergedClean()`), and the GUI combines it with its sessions, terminals and
  workspaces slices in `isCleanable` (`lib/projects.ts`, table-tested; hooks in
  `components/projects/useCleanable.ts`, one boolean per store per row).
- the daemon side of the cleanup is `repo.Cleanup` (a function over the `repo.Store`
  interface, so the fake gets it too) with a `Hold` callback; `RepoService.CleanupWorktrees`
  passes the hold the daemon wires in `daemon.go` (`api.Repo.WithCleanupHold`, the same
  closure pattern the workspace store uses for live threads).

## Command

`repo.worktree.cleanup <repo> [<path>]` (`internal/command/commands_repo_cleanup.go`):

1. A dry run (`CleanupWorktrees{dry_run}`) resolves the repo by id or name (an unknown one or
   path fails before anything runs).
2. `git.fetch`'s operation on the main worktree (GitOpsService.Fetch), when the repo has an
   `origin`; the GUI gets the usual fetch toast. A failed fetch aborts: nothing is removed.
3. `CleanupWorktrees`: `Refresh` (reconcile, base, every status, waited for), re-evaluate
   each worktree, ask the hold right before each removal, then `RemoveWorktree` without
   `--force` and without `--delete-branch`. A failed removal is a skip with git's error.
4. Result: `Removed 2 worktrees: cf/a, cf/b; kept 1 worktree: cf/c (uncommitted changes)`;
   `--json` gives the response (removed and skipped with reasons).

The confirm prompt is a `DynamicConfirm` from the dry run: "Remove 2 worktrees whose work
is in origin/main: cf/a, cf/b? Branches are kept; each is checked again after a fetch." (one
path: "Remove the worktree of cf/a (<path>)? …"; nothing yet: the static "Fetch <repo> and
remove its worktrees whose work is already in the default branch? Branches are kept.").

## UI

- Emerald "in main" tag (`GitMerge`, `data-testid="worktree-cleanable"`, tooltip "Clean: no
  changes, every commit is in <base_ref>, no live thread or terminal") in the state group,
  left of the PR badge. It lives in `WorktreeState`, so workspace members could show it,
  but a member is always held.
- A fourth row action, the broom (`worktree-cleanup`, emerald), runs the command with
  `path`. Column width: a project where some row is cleanable gives every row four slots
  (`w-24`, the others an empty slot) so the state columns still end at one x; projects with
  nothing to clean keep three (`w-18`). A project with one cleanable row does not widen
  every other project.
- Project menu: "Clean up merged worktrees" with a count (`project-cleanup`,
  `project-cleanup-count`), after New worktree…, disabled at 0. Offered for git projects
  with a remote only: without one there is no `origin/<default>`, so it could never be
  enabled.
- Toasts: the fetch's gitops toast, then the command's result (`runCommand`).

## Decisions and gotchas

- **The fetch can widen the set.** The prompt lists what is cleanable before the fetch; the
  run removes whatever is cleanable after it (a merge done elsewhere shows up only then).
  Anything removed meets the same rule and keeps its branch, so nothing is lost; the result
  message names exactly what went. Verified end to end: a branch merged in another clone
  and pushed was removed by a run whose prompt listed nothing.
- **Fresh worktrees count.** A worktree with no commits of its own and no changes is "in
  main" by the rule (every commit on HEAD is in origin/main). Removing it loses nothing in
  git, but `git worktree remove` deletes ignored files (node_modules, local `.env`) along
  with the directory. In this repository, worktrees made by other tools (T3 Code) whose
  agents the app cannot see are tagged too when clean; the hold only knows the app's own
  threads and terminals.
- "Merged" means reachable from origin/<default>: a squash-merged branch keeps
  `base_ahead > 0` and is not cleanable. Merge commits (this repo's PRs) work.
- `git status not read yet` (zero `RefreshedAt`) is not cleanable, so a just-registered
  repository shows nothing until its first status.
- lucide 1.x has `Broom` (the sketch's icon), used instead of `Brush`/`Paintbrush`.
- The mock: `POST /__mock/worktree/merged?repo=…&branch=…` adds a clean worktree on
  `origin/main` (merged_clean is computed like the daemon's), and `repo.worktree.cleanup`
  mirrors the daemon (hold, confirm text, result message; no fetch).

Tests: `internal/store/repo/cleanup_test.go` (rule table; a real temp repo with a bare
origin: merged clean removed with its branch kept, dirty, unmerged and held kept with their
reasons, dry run removes nothing), `internal/daemon/cleanup_test.go` (holds),
`internal/command/commands_repo_cleanup_test.go` (args, call order, no fetch without origin,
failed fetch removes nothing, prompts), `lib/projects.test.ts` (`isCleanable`), e2e
`projects.spec.ts` (tag on the fixture only, broom removes it after a confirm naming the
branch, menu count and disabled at 0, a terminal holds it, aligned columns).

Screenshots (real app, isolated `CODE_FOUNDRY_HOME`): `docs/notes/projects-polish-3/`.
