# Child threads open as preview tabs

A user's click in the window that opens a child thread (a thread another thread created, while
that creator exists: `lib/inSidebar.ts`) now opens it as the space's preview tab, as a click on
an Archived or Snoozed sidebar row already did (`shell-model.md`, "Preview tabs";
`preview-tabs-1-daemon.md` to `preview-tabs-3-gui.md`). Children are their lead's to manage, so
looking at one should not leave a kept tab behind.

## What changed

| Where | What |
| --- | --- |
| `internal/layout/thread.go` | `OpenThread.Child`: a preview is honoured for an archived, snoozed or child thread. A child's preview leaves its remembered set put away |
| `internal/command/commands_thread_open.go` | `thread.open --preview` sets `Child` when the thread's `created_by` names a thread that still exists (`isChild`; a NotFound creator is a sidebar thread) |
| `gui/frontend/src/stores/openThread.ts` | `previewOnOpen(byId, id, from)`, the one rule, and `openThread(id, { preview?, focusPrompt?, from? })` |
| call sites | lineage rows, the wake note link, thread and agent search hits, notifications, Needs you, prompt history, Ember board workers, a memory's "by" link, Projects page thread rows: all call `openThread` |
| `gui/frontend/mock` | the mock's `thread.open` and `open_thread` know a child (`isChild` from the world) |

## Decisions

- **One decider, from the thread.** `openThread` asks `previewOnOpen` when the caller gives no
  `preview`: archived, snoozed (or saved), or a child. The sidebar still passes its own answer
  (its section), so a sidebar click is unchanged. Archived and snoozed threads opened from the
  other call sites (a search hit, a memory's link) now preview too, as the notification link
  already did: the rule is the thread's, not the call site's.
- **The lead from its child stays kept.** `from` is the thread the click is in; a thread that
  created it (directly or further up) opens kept. The wake note passes it (a lead's wake note
  from its child previews the child; a child's from its lead opens the lead kept, even when that
  lead is itself a child). The parent row and the creator link do not go through `openThread`:
  they stay plain selects, kept, as before.
- **A child's preview shows only its conversation.** An ordinary open brings back the thread's
  remembered set, and placing a linked tab keeps the thread's preview (`place` -> `keepThread`),
  so restoring would have kept it at once. The set stays remembered and comes back on the
  child's next kept open, as a snoozed thread's waits for its wake.
- **Who is a child is the daemon's to check.** The window decides when to ask for a preview;
  the daemon decides whether the thread may be one, as for archived and snoozed threads. A
  thread or a page cannot ask (`--preview` is the user's only), so a lead's own `thread.open`
  of its child is a kept tab, as before.
- **Sends.** The daemon's glue keeps a preview when its thread is unarchived or woken; an active
  child is neither, so a message its lead sends keeps nothing. The user's message is typed in
  the composer first, and that keeps it (`useKeepPreviewOnDraft`).

## Verification

- Go: `internal/layout/testdata/ops/open_thread-preview-child*.json`,
  `open_thread-preview-archived-replaces-child.json`, `open_thread-child-kept-restores.json`;
  `TestThreadOpenPreview` (a child, a child whose creator was removed, no `--preview`, from a
  thread).
- vitest: `stores/openThread.test.ts` (the rule's table and each store call site),
  `LineageGroup.test.tsx` (a child row previews, the parent row does not),
  `lineageRows.test.tsx` (the wake note link both ways), `mock/layoutVerbs.test.ts`.
- End to end against `make drive`: a child opened from its lead's thread info card shows the
  dashed preview tab; a second child replaces it; typing in its composer keeps it.
