# Removing a thread removes its hidden children (2026-10-30)

Alex: "removing a thread that has child threads should remove those as well, the same way
that archiving a thread that has child threads archives them." Until now `Remove` handed
its children to the user instead (`orphans.go`: each unarchived child got the sidebar
override, nothing was stopped), which left agent-made threads the user never asked for in
the sidebar after removing their lead.

## Decisions

* **Same set as the archive cascade.** `Remove` walks `ArchiveCascade` with the live
  `threads.show_created_threads` setting: hidden descendants only, a shown thread and
  everything below it stays. Unlike the archive, **hidden archived descendants go too**:
  nothing would lead to them once the creator is gone (an archived hidden thread is not
  in the Archived list either).
* **Order.** The thread's own process is closed first, so it creates no more; then passes
  over the hidden threads below it (tree order, closes begun together, each marked
  `Removing` before any is removed so a child's removal adopts no grandchild that goes in
  the same pass), until a pass finds none, capped at 4; then the thread itself. Archive
  does descendants, root, descendants; remove cannot run a pass after the root is gone
  (the lineage walk needs it), hence close-root-first.
* **Partial failure** mirrors Archive: the failed child is skipped, its `Removing`
  cleared so the root's removal adopts it (shown in the sidebar), the root is still
  removed, and `*CascadeError` (new `Verb` field, "removed") names the failures:
  FAILED_PRECONDITION after the fact.
* **`Options.Removed` fires for each** removed thread (hidden children first), so the
  daemon's worktree cleanup sees them all.
* **Adoption stays as the safety net** (`adoptOrphansLocked` in `removeOne`,
  `adoptLoadedOrphans` at load): a child created in the moment between the last pass and
  the root's removal, a failed cascade target, or rows from an older daemon.
* **Confirmation** (`removeConfirm`): the hidden threads removed along are named even
  when idle, since a removal forgets them: "N hidden child threads below it are (1 still
  working) removed too. To keep one, show it in the sidebar first." It lists with
  `archive_cascade_of` + `include_archived`. The archive's text is unchanged.
* **Mock daemon** `thread.remove` cascades the same way (`removeOne` + `archiveCascade`).
  No GUI change: the GUI runs the command and shows the daemon's confirmation.

## Tests

`TestRemoveCascadesThroughHiddenChildren` (live child + grandchild + archived child go,
shown child and its child stay, survives restart, orphan-at-load still adopts),
`TestRemoveWithCreatedThreadsShown` (setting on: nothing cascades),
`TestRemoveCallsRemovedHook` (3 calls, children first), `TestThreadRemoveHiddenChildren`
(confirmation wording).
