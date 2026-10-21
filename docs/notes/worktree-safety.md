# Worktree safety (fuzz fixes, part 1)

Status: `cf/worktree-safety`, the first of two PRs for the 2026-10-21 git fuzz report
(findings git 1, 2, 5, 6, 7). Part 2 (`docs/notes/worktree-paths.md`) covers 3, 4, 8,
9 and api 4. `make check` green; run end to end against a scratch daemon
(`CODE_FOUNDRY_HOME=~/cf-fix-git/cfhome`, file-remote "origin").

## What changed

* **Branch delete means merged (git 1).** `project.branch.delete` without `--force`
  checks the local tip and, with `--remote`, origin's tip (fetched first, so a branch
  only on origin is checked too) against origin/<default> (the local default branch
  when there is no origin copy): reachable from it, or `mergedByContent` (the cleanup
  rule for squash/rebase merges). An unmerged tip refuses the whole call, nothing
  deleted, "branch x has 2 commits not in origin/main; --force deletes it anyway".
  When the first comparison says unmerged, origin's default branch is fetched once and
  compared again, so a PR merged on GitHub a minute ago is not refused for a stale ref.
  The local delete is then `branch -D` (checked already; `-d` would refuse a squash-
  merged branch whose upstream is gone). The remote delete is
  `push --force-with-lease=refs/heads/x:<checked sha> --delete`, so a copy that moved
  after the check is not deleted ("moved while it was checked").
* **`worktree remove --delete-branch` (git 2)** uses the same rule. The worktree is
  removed first; an unmerged branch is kept and the call returns FailedPrecondition
  saying so (the existing "worktree removed, but ..." pattern), pointing at
  `project branch delete --force`. `--force` deletes it. The workspace verbs inherit
  this through the project store; workspace rollback passes Force, so it still deletes
  the branches it just made. The CLI/GUI confirm mentions that an unmerged branch is
  kept, and the uncommitted-work second question names the branch when the re-run
  with `--force` would delete it.
* **Held worktrees (git 6).** `RemoveWorktreeOptions.Hold` (same shape as
  `CleanupOptions.Hold`); the API passes the daemon's cleanup hold, so a thread on the
  worktree, a running terminal or a workspace membership refuses removal, naming it,
  unless `--force`. When the worktree also has uncommitted changes the message says
  `--force` deletes them. The workspace store and Cleanup call the store without a
  Hold (they check their own). The GUI shows the error toast; a holder in the first
  confirm would need another RPC, not done.
* **Unborn initial commit (git 5).** `ensureBorn` makes the root commit with
  `hash-object -w -t tree /dev/null`, `commit-tree --no-gpg-sign`, and
  `update-ref refs/heads/<b> <sha> ""` (refuses if the branch appeared meanwhile). No
  hooks, no signing prompt, index untouched: staged files stay staged.
* **Nested projects (git 7).** `newproject.Delete` refuses when another registered
  project, or a worktree of one, is inside the folder (`fsx.Within`), naming it.
  `clone.Clone` refuses (`ErrNested`, FailedPrecondition) when `projects/<owner>`
  holds a `.git`.

## Gotchas

* `--force` on `worktree remove` now means "accept losing work" across the board:
  uncommitted changes, holds, unmerged branch. Splitting it into separate flags was
  considered and rejected: every case is the same answer to the same question.
* A branch with no default branch to compare with (no origin/<default> and no local
  one) is refused without `--force`.
* The orchestrate skill's "discarding a child's work" now says `--delete-branch
  --force`, since discarded work is unmerged by definition.
