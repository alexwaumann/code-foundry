# Fuzz pass 2026-11-15: toasts

## Found

From a thread header's ⋯ menu, Move to space ▸ <space> and Snooze ▸ (a preset or Save for
later) made the thread's tab disappear and said nothing. With the sidebar hidden, nothing on
screen showed where the thread went. Archive from the same menu toasts, as the success-toast
rule (toast-success-rule.md) asks when the place is gone and nothing else shows the result.

## Cause

- `SnoozePresetItems` always ran `{ inView: true }`. That was written when a snooze from the
  header left the pane's snooze strip on screen. In the shell, snooze closes the tab, so the
  strip is never seen.
- Move to space ran through `runLinked`, and that is always quiet.

## Fix

- `SnoozePresetItems` takes `inView` (true by default, for the row's Snooze button), and
  `ThreadMenuItems` passes `kit.rowInView`, as Pin and Archive do. The header's menu now
  toasts the daemon's sentence. The row's menu stays silent because the row leaves for
  Snoozed.
- `moveThreadToSpace(thread, space, source)` (shell/spaceActions.ts) runs thread.space.move
  with the thread's context. When the move succeeds and the source is not `inView`, it toasts
  "Moved to <space>" (success) with a Go to space button (space.switch). `MoveToSpaceItems`
  calls it with `kit.rowInView` for a space and for New space, so the header toasts and the
  shell row's menu stays silent. Its `onPick` prop and `moveToSpaceAction` (shell/linked.ts)
  are gone. A drop on a space tab (`runSpaceDrop`) is unchanged and silent.

## Gotchas

- The header's menu used to run the move with the window's context and the row's menu with
  the thread's. Both now use the thread's. The verb names the thread by `id` anyway.
- A move from the header no longer sets the menu's `moved` flag, so the menu's close leaves
  focus as Move to space ▸ New space always has.
