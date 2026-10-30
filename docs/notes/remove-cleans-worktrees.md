# Remove cleans worktrees

Status: done on branch `cf/remove-cleans-worktrees`. A removed thread's derived worktrees
go the way an archived thread's do (`docs/notes/workspaces-v2-1-threads.md`, "Cleanup on
archive"), instead of waiting on the abandoned sweep, whose stricter verdict (merged into
base, or no commits since made) left a removed thread's worktree with unmerged commits on
disk for good.

## Decisions

* **Hook shape: a second hook, `thread.Options.Removed func(t Thread)`,** beside
  `Archived`, not one `Done(t, reason)` hook. It is the smaller change: `Archived` and its
  one caller stay as they are, the daemon wires one more field, and each hook keeps a
  contract that reads on its own (Removed: after the tombstone is in and the row is gone).
* **When it fires.** `Remove` calls it under the store's lock, after `rebuildLocked` (the
  row is out of the snapshot) and after the tombstone is added, with the thread as it was
  (`rec.s`). The cleaner's "no other thread has it" check (`checkoutThreads`) reads the
  snapshot, so the removed thread never holds its own worktrees. A failed removal calls
  nothing.
* **No cascade** (then; since `docs/notes/remove-cascades.md` a removal takes the hidden
  threads below it along and the hook fires for each of them, then the thread).
  `thread remove --ids` calls `Remove` per id: one hook call each.
* **Same cleaner, same verdict.** The daemon wires `Removed` to `archiveCleaner.removed`,
  which runs the same `clean` as `archived`: `project.Cleanup` per derived, registered,
  existing checkout with `project.ArchivedVerdict` and `cleanupHold` (no other thread that
  is not archived has it as cwd or checkout, no terminal in it). Clean: removed. Dirty, mid
  operation or held: kept, with the reason logged; it stays listed under its project on the
  Projects page. Never `--force`, never the branch.
* **Logs.** Every cleanup line now carries `cause=archived|removed|unregistering`, so a
  removal's lines say "removed" where an archive's say "archived"; the messages themselves
  ("worktree removed (its branch stays)", "worktree kept", "worktree not cleaned up") are
  unchanged.
* **The abandoned sweep stays the backstop** (`cleanup.go`), and the tombstone's
  `WorktreePath` keeps its meaning (the primary path only). Removing an already archived
  thread runs the cleanup again: its worktrees that went at the archive are missing and
  skipped; one kept then (dirty) gets another try.
* **Confirm text.** `thread.remove`'s confirm (CLI; the GUI shows the daemon's text) adds
  "Its clean worktrees are removed; branches stay." for one thread, "Their clean worktrees
  are removed; branches stay." for several when any of them has worktrees Code Foundry
  made. "Made" is worktree mode as the store reads it: `created_worktree` and a branch (a
  thread with `created_worktree` and no branch derives nothing, so it says nothing). One
  `List` (all, archived included) answers it; a failed list says nothing extra. A thread in
  place or in a folder keeps the existing wording. The mock's confirm now matches the
  daemon's text, with the same sentence for its worktree-mode threads.

## Verified

`make check` green. End to end on a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-remove-wt`,
this branch's binary) over scratch repos `web` and `api` (bare origins) registered as
projects; threads created with `thread new --projects web,api --new-worktree`, not sent a
message:

* `rm1` removed: both worktrees gone ("worktree removed (its branch stays)" thread=…
  cause=removed for each project); `git branch` in both repos still lists `feat/rm1`.
* `rm2` with an untracked file in its api worktree, removed: the web worktree gone, the api
  one kept ("worktree kept … cause=removed … reason=\"uncommitted changes\""); `feat/rm2`
  stays in both.
* `rm3a` and `rm3b` (`--like rm3a`, the same branch and worktrees), `rm3a` removed: both
  worktrees kept, `reason="thread rm3b is on it"`. Archiving `rm3b` then removed both
  (cause=archived); removing the archived `rm3b` afterwards logged no warning.
* Confirms: `thread remove <rm1>` without `--yes` printed "Remove thread s-…? Claude stops
  if it runs, and the thread is forgotten. Its clean worktrees are removed; branches
  stay."; an in-place thread's printed the old wording only; `--ids <in-place>,<rm3b>`
  printed the plural sentence.

Tests: `TestRemoveCallsRemovedHook` (thread store: once with the thread as it was, row gone
and tombstone in; children not passed; an unknown id calls nothing), `TestRemoveCleanup`
(daemon: clean members removed, a dirty one kept, a worktree another live thread holds
kept, the reasons and `cause=removed` logged, no branch touched), confirm rows in
`TestThreadRemoveIDsConfirm`, and the e2e confirm case asserting a checkout thread has no
worktree sentence.

## Follow-ups

* The tombstone still records only the primary path; a removed thread's member
  worktrees that were kept (dirty) are found under their projects on the Projects page,
  not from the tombstone.
* The mock's initial world has no worktree-mode thread with a row menu in the e2e, so the
  positive sentence is covered by the Go rows and the CLI check, not by Playwright.
