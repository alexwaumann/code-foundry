# Clean up merged worktrees: a scannable dialog that names only what goes

The cleanup confirm was one paragraph of daemon prose: every worktree that would go and
every one kept, each with its full path and a long reason, plus an "also removable if
their uncommitted work is deleted" section and a second confirmation to delete that work.
The result toast repeated it. A user found it wordy and hard to scan.

## Decisions

- **Only what goes, only what went.** The dialog lists the worktrees the cleanup would
  remove; the toast names the ones it removed. Nothing about what stays: the project page
  already says why each leftover stayed.
- **Uncommitted work is never cleaned up.** The `force` arg, the dirty second stage and
  `CleanupWorktreesRequest.force` are gone. A merged worktree with uncommitted files stays
  until the user removes it with Remove worktree (which names the files it deletes).
- **The dialog (sketch A):** title "Remove N merged worktrees?", one line ("Their work is
  already in origin/main. Branches are kept."), a bordered list of rows with the branch
  (mono) and a short why on the right: merged, squash-merged, no commits. No paths, no
  warning triangle (nothing unrecoverable), button "Remove N worktrees". With nothing
  merged right now it offers the fetch alone ("Fetch and check").
- **The toast:** "Removed N worktrees" with the branches under it (mono), or "No merged
  worktrees to remove".
- **JSON and CLI report the same thing.** `CleanupWorktreesResponse.skipped` is gone (field
  reserved): an agent learns what went; why another stayed is on the worktree itself
  (`merged_clean`, `cleanup_reason`). The text result is "Removed 2 worktrees: cf/a, cf/b".
- **One path that stays fails.** `project worktree cleanup <project> <path>` for a worktree
  the run keeps is a FailedPrecondition with why ("cf/x was not removed: 1 commit not in
  origin/main"), not "Removed 0". A dry run with a path lists nothing instead: the real
  run fetches first and may remove it.

## How it works

- `RemovedWorktree.kind` (`CleanupKind`: merged, squash-merged, no commits) comes from the
  store's verdict (`cleanupJudge` returns it with the reason); other rules (the archived
  thread's `ArchivedVerdict`) leave it unspecified and the CLI prints their reason.
- The GUI registers a confirm presenter for `project.worktree.cleanup`
  (`stores/cleanupWorktrees.tsx`): it runs the dry run (`previewCleanup`, the RPC with
  `dry_run`) and opens `CleanupWorktreesDialog`. No project, or a failed dry run: the
  generic confirm with the daemon's words. The project page's actions run the command
  quietly and toast from its JSON (`removedByCleanup`); the palette gets the daemon's
  one-line message.

## Gotchas

- The rows come from the daemon's dry run, not the store's `mergedClean`, so they include
  an abandoned new worktree the page's count does not. That case is rare (archiving a
  thread already removes its clean worktrees).
- An async test helper that returns the run's promise gets it flattened by `await`; the
  dialog test returns `{ done }` instead.
