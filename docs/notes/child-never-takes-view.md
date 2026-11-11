# A child thread never takes the view

A user's window sometimes switched to a thread an agent had just created through its CLI.
A thread another thread creates (created-by) is hidden from the sidebar and belongs to its
creator, so it must never move the user's view.

## Cause

Every thread-starting verb (`thread.new`, `thread.new-like`, `thread.fork`, the `pr.*`
thread verbs, `theme.ask`) called `focusCreated`, which emitted a `FocusThread` intent
unless `--focus=false`. The GUI skipped that intent for a hidden thread only when the
thread had been created less than 10 s ago (`NEW_THREAD_FOCUS_MS`), and otherwise took it
for an explicit `thread.focus` and selected it. The thread's `CreatedAt` is stamped before
setup, and the CLI emits the focus only after setup returns, so a child with a new
worktree and a setup hook arrived "older" than 10 s and the view jumped to it.

## Decisions

- The daemon decides. `focusCreated` takes the created thread from the response and emits
  nothing when its `CreatedBy` is set, so every caller is covered without each one passing
  the caller's context. `--focus=true` on a child changes nothing: `thread.focus` is the way
  to show one. The `focus` arg's description says so.
- A user's own creation (composer, palette, the CLI outside a thread) still focuses. A
  page's bridge still sends `focus=false` unless the page passes it.
- `thread.focus` emits its `FocusThread` with `explicit: true`, as `--focus` on the
  `view.panel.*` verbs already did, so asking for a hidden child selects it.
- The GUI drops the creation-time guess. `threadFocus(t, byId, explicit)`: an unknown
  thread waits for the list; an explicit intent selects; a non-explicit one selects only a
  thread in the sidebar (`inSidebar`) and skips a hidden one. With the new daemon the GUI
  never sees a non-explicit focus for a child; the rule stays as the defence for a new GUI
  on an old daemon during an update.
- The mock follows the daemon: its thread-starting verbs skip the focus for a created-by
  thread, and `POST /__mock/thread/focus` (standing for `thread.focus`) is explicit.

## Gotchas

- Only `CreatedBy` decides. `pr.*`, `theme.ask`, `thread.new-like` and `thread.fork` set no
  created-by, so a thread one of them starts is a sidebar thread and still focuses, also
  when an agent runs the verb. That is unchanged and is not a child.
- An old GUI on the new daemon: `thread.focus` on a hidden child created over 10 s ago was
  selected before and still is (the old GUI selects any explicit intent). On a child
  created under 10 s ago the old GUI used to skip a non-explicit `thread.focus`; with the
  explicit flag it now selects it, which is what was asked.
- The orchestrate skill's `reference/sidebar.md` now says creating a child never moves the
  user's window and that `thread focus --id <id>` shows one on request. No skill or guide
  text told agents to pass `--focus=false`.
