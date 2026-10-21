# Worktree paths, submodules, fetch round (fuzz fixes, part 2)

Status: `cf/worktree-paths`, the second of two PRs for the 2026-10-21 git fuzz report
(findings git 3, 4, 8, 9 and api 4), on top of `cf/worktree-safety`
(`docs/notes/worktree-safety.md`). `make check` green; run end to end against a
scratch daemon.

## What changed

* **Hand-deleted worktrees (git 3).** git keeps the admin entry of a worktree whose
  folder is gone ("prunable"); the snapshot hides it and nothing pruned it, so
  `worktree add` at that path ("missing but already registered"), a thread's
  recreate, and `branch delete` ("used by worktree at") failed for three months.
  `dropStaleWorktrees` lists worktrees and runs `git worktree remove <path>` on each
  prunable entry at the target path or on the target branch, before `worktree add`
  and before a branch delete. Only matching entries go: a blanket `git worktree prune`
  in reconcile would also drop a user's worktree on an unmounted volume, so reconcile
  does not prune. Never `add -f`.
* **Same-named projects (git 4).** The per-project worktree directory is
  `worktreeDirKey`: the slug or `_local/<name>`, plus `-<first 8 of the id>` when
  another git project registered earlier has the same one (case-insensitive, as
  APFS). The first project keeps the plain directory, so its existing paths, which a
  thread's recreate compares with, never move. `requireFree` Lstats the target before
  `worktree add -b`, so a collision fails before git creates a stray branch.
* **Submodules (git 8).** git refuses to remove any worktree with an initialized
  submodule. When it does and the refreshed status is clean (porcelain v2 reports a
  modified or untracked submodule as `.M`, counted as modified) and
  `git submodule foreach --recursive 'git rev-list -1 HEAD --branches --not --remotes'`
  prints nothing (no submodule commit its remote lacks), RemoveWorktree retries with
  `--force`. Cleanup benefits through RemoveWorktree.
* **Fetch round (git 9).** The fetch loop's run is `fetchAsync`: each due project's
  fetch runs in the background, at most `fetchConcurrency` (3) at once, never two for
  one project (a project whose fetch still runs is skipped that round). The tier
  schedule records the attempt when it starts, as before. One unreachable remote now
  holds one slot for its timeout instead of the whole round. No backoff added: the
  slot cap already bounds the damage.
* **Workspace create (api 4).** Members, git, duplicates, base refs and the name are
  checked before `branchFor` (which may ask the namer, a model call); the name is
  checked again under the lock. ctx already reached the namer.

## Gotchas

* A project registered later that already had worktrees under a shared directory
  (before this change) makes new ones under the suffixed directory; a thread of it
  whose worktree is gone then fails recreate's same-path check with a clear error.
  Fixing that would need CreateWorktree to take the stored path; not done.
* Another project's GitHub slug is known only after its first reconcile, so in the
  first seconds after a daemon start a collision between two GitHub checkouts may not
  be seen; `requireFree` still stops a same-branch collision.
