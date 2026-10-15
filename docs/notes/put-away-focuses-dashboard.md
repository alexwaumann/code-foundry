# Put-away threads focus the dashboard

2026-10-15. Archiving, snoozing or removing the thread a window is viewing now selects
the dashboard. Before, an archived or snoozed thread stayed selected with its Reconnect
card, and a removed one left a stale selection showing "This thread no longer exists."

## Decisions

* **All three put-aways, one rule.** Archive, snooze and remove behave the same. Snooze
  was included deliberately: it shares the archive cleanup path and also takes the thread
  out of the main list.
* **React in the store, not around the buttons.** The rule lives in
  `stores/archiveCleanup.ts` next to the panel resets, as a `useSessionsStore`
  subscription. So an archive or remove from the CLI, the palette, a row menu, the header
  button or another window all land the viewing window on the dashboard. Wrapping only the
  GUI's `archiveSession` / `removeSession` calls would have left the other sources showing
  a dead thread.
* **Only the selected thread counts.** Putting away or removing any other thread leaves
  the selection alone. Unarchiving, waking, a re-snooze to another time and unrelated
  updates change nothing, and the first List is not a transition (`newlyArchived` /
  `newlySnoozed` already require the thread to have been known and unset before).
* **Removed = known before, gone now.** `newlyRemoved(prev, next)` is `prev.order` minus
  `next.byId`, so both a `removed` event and a snapshot that no longer carries the thread
  count. A `removed` event for an id the store never had is nothing.
* **Select, do not focus.** `ui.select(DASHBOARD)` only. Keyboard focus stays where it
  was (the row menu's listbox, the header), matching how the rest of the app treats
  selection changes from events. The sidebar's Dashboard button highlights because the
  selection is `view:dashboard`, not `none`.
* **ThreadMissing stays** in `ThreadPane.tsx` for the "first List has not loaded yet"
  case and for a stale selection restored before the store has anything.

## Tests

`stores/archiveCleanup.test.ts`: tables for `newlyRemoved` and `putAwaySelected`, and a
`selection` block under `startArchiveCleanup` covering archive, snooze, removed event,
snapshot-without-it, another thread put away, unarchive / wake, and a page selection.
