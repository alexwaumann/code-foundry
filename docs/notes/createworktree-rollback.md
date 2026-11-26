# CreateWorktree rollback tells subscribers

Status: `fix/project-createworktree-rollback`. `go test -race ./internal/store/project/` and
`make check` green.

## The bug

The fast path from #897 (`registerCreatedWorktree`, docs/notes/perf-project-sched-fetch-fsx.md)
adds the new worktree's slot and publishes `ProjectUpdated` with it before it waits for the
worktree's base and status jobs. When that wait failed (the request context cancelled, or
`worktreeTimeout`), its `rollback` deleted the slot and called `commit(nil)`, which publishes
nothing. CreateWorktree's undo then removed the worktree from disk. The reconcile after that
found the slot already gone, so it saw no change and sent nothing either. The GUI's projects
store, the file-index watcher and every other `project.Event` subscriber kept a worktree that
did not exist until some unrelated `ProjectUpdated` for the project came along.

`TestCreateWorktreeCancelledAfterPublishTellsSubscribers` (create_rollback_test.go) holds the
new worktree's `git status`, cancels the request, folds every event into a view the way
`stores/projects.ts` does, and checks the view ends equal to the snapshot without the
worktree. Before the fix it failed with "a subscriber still has undone worktree ...".

## The fix

- `registerCreatedWorktree` no longer rolls back. A failed wait returns the error and leaves
  the slot alone.
- CreateWorktree's `undo` (it runs only when the context is done, which is the only way the
  waits fail) removes the worktree from disk with `undoAdd` first, then calls
  `dropUndoneWorktree`. That deletes whatever slot is at the path (the fast path's, or one a
  reconcile added after listing the new worktree), its watch routes and detail cache entries,
  syncs the stream, and publishes `WorktreeRemoved` then `ProjectUpdated` in one commit: the
  same events, in the same order, as reconcile sends for a worktree that left the list. No
  slot, no events.
- When `undoAdd` fails the worktree is still on disk, so its slot stays and nothing is sent.
  Before, the slot went silently while the worktree stayed, until the next reconcile.
- Every undo exit gets this, not just the fast path's: the first-reconcile path
  (`DefaultBranch == ""`) and the fallback refresh both let a reconcile add the slot and
  publish it before a cancelled wait. They used to wait for a watcher-triggered reconcile.

## Gotchas

- Order matters: disk first, then slot. Dropping the slot first (as the old rollback did)
  lets a reconcile list the still-present worktree and add it back between the two steps.
- A reconcile that listed the worktree before `undoAdd` removed it can still commit after the
  drop and add it back. `dropUndoneWorktree` queues a low-priority reconcile, which lists after
  `undoAdd` (a request while one runs becomes a rerun), so the store gets there without
  relying on FSEvents. Its `listedAt` guard does not keep the slot: the made record is older
  than that listing.
- Consumers of `WorktreeRemoved` that act on it (the shell reaper, action cleanup) check that
  the directory is gone first. It is, because the event is only sent after `undoAdd` succeeded.
- The made record (`project_worktrees`) for the undone path is left for reconcile's
  `staleMadeLocked`, as before.
- The thread store's callers (`makeWorktree`, `recreateWorktree`, the last-branch remake in
  placement.go) return the error and never record the worktree as theirs, so their own
  rollback does not touch it. `memberWorktree` already refuses a listed worktree that is not a
  directory, so the old phantom could not be shared by a retry; now it is not listed at all.
- What a user sees: on a cancelled create, the new worktree can appear in the Projects page
  for a moment and then disappear. Before, it appeared and stayed.
- The success path is unchanged: still one `git status` for the new worktree only
  (`TestCreateWorktreeFastPath`).
