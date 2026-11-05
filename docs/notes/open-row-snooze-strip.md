# The open thread's row under a collapsed footer, and the snooze strip

Frontend only. A user could open a snoozed or archived thread and lose sight of it in the
sidebar, and the composer's Unsnooze read as part of the prompt.

## The row

- `buildSections` takes `openThreadId`. A collapsed Snoozed or Archived footer keeps that one
  row; its header stays collapsed with every thread's count. An expanded section and Working do
  not read the option.
- It filters the section's own list, so the rules come for free: a hidden child is not in the
  list and gets no row (and its snoozed creator gets none either: the rule is about the open
  thread, not `sidebarAnchor`'s row), a live thread is in no footer, and a thread woken or
  unarchived while open is in one place, the main list.
- The open thread is the selection, so a subagent view keeps the row: it does not change the
  selection, only what the pane shows.
- The row is a row. `getListOptions` passes the selection too, so `threadOrder` (cmd+1..9,
  cmd+shift+a, cmd+shift+[ and ]) matches the screen, and the arrows start from it.
- The sidebar passes the id only while that thread is snoozed or archived
  (`useOpenPutAwayId`). The result is the same, but moving between live threads then changes no
  input of `useListRows`: a rebuild would hand every panel new arrays and `virtualizer.measure()`.
- Height: one 24px row and the panel's 4px, inside the footer's existing cap. The caps did not
  change.
- Snoozing or archiving the open thread still sends the window home (`archiveCleanup`), so the
  row appears for a thread opened after it was put away: an expanded section, then collapsed,
  or the palette, a link, search.

## The strip

- `DockStrip.tsx` is the shell: the box class and the line (icon, truncating sentence, actions).
  `WaitingStrip` and `SnoozeStrip` both use it. The CSS class went from `waiting-strip` to
  `dock-strip`.
- Both strips can show on one thread. The dock's top padding is set once by `:has`, each strip
  has 8px under it, so they stack 8px apart; waiting on top, snooze next to the composer. The
  dock's measured height covers them, so the list's bottom inset needs nothing.
- The strip is in `ThreadPane`'s and `InlineThread`'s docks: the old note lived in the composer,
  so both had it. Ember's dock has none, since the daemon refuses to snooze a resident thread.
- It is keyed by thread, so a pending press on one thread does not hold another's button.
- `SnoozeNote` keeps only "Snooze ended", and checks `isSnoozed`: the old line preferred the
  snooze text over a stale wake status, and with the strip apart it would otherwise show both.
- The title menu's Unsnooze stays.
