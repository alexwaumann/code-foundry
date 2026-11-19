# Clearing a woken thread

> **Superseded in part (2026-11-19, composer-row-pill.md):** in the thread, the woken strip is now the snooze segment of the pill above the composer ("Snooze ended 2m ago", amber); Clear and the snooze presets are in its menu. The sidebar part below is unchanged.

A thread whose snooze ran out reads needs attention "snooze ended" (Woke) until the user
sends, snoozes again or archives. There was no way to just say "seen it". Agreed design: the
sketch's option A in the sidebar and in the thread.

## The verb

- `thread.snooze.clear` (internal/command/commands_thread_snooze_clear.go), in the snooze
  verb's family like `thread.flag.clear`. It calls the new `ThreadService.ClearSnoozeEnded`,
  which runs the store's `clearSnoozeEnded` (what a re-snooze and an archive already did):
  idle "at prompt", persisted and published. `thread snooze --clear` still means unsnooze; the
  description says so, since "clear" alone could read as either.
- On a thread that is not woken the RPC answers `cleared: false` and nothing changes; the verb
  says "was not woken from a snooze; nothing to clear".
- `When`: in a window, only while the active thread is woken (it reads the thread, as
  `thread.run-in`'s `runElsewhere` does); from the CLI whenever a thread is named, so Run can
  say why it did nothing. The GUI's palette applies the same rule to its own copy of the
  thread (keys/bindings.ts `inPalette`), since its command list can predate the wake.
- NoIndex: it is the user's own attention, like `thread.stop-waiting`. In the palette.
- Opening a woken thread still does not clear it (the daemon's `clearedWhenSeen` leaves
  "snooze ended"). The mock did clear it on a look; it now matches the daemon.

## Sidebar

- The bug: since the title-first rows (docs/notes/sidebar-title-first.md) every row's status
  word is screen-reader only, and the Needs you rows say their ask in words (AskKind). A woken
  thread is not an actionable ask, so it sits in Active, where its bell alone read as nothing.
  `StatusEntry.rowWord` marks the one kind whose word shows on an Active row: "Woke", amber.
  Other Active statuses keep the icon.
- While a row is woken its hover actions are Snooze and Clear: Clear takes Archive's place,
  same button (check icon and word), in the same hover slot over the status. Archive stays in
  the context menu. Cleared, the row is idle with Snooze and Archive again. No toast.
- The hover card now shows the bell and "Snooze ended · 2m ago" (a moment, like "Finished 6m
  ago") instead of the generic alert icon and "for 2m".

## Thread

- The composer's amber line (SnoozeNote) is gone. SnoozeStrip has a woken form in the snooze
  strip's place: bell, "Snooze ended · 2m ago" in the warning tone, Snooze again (the preset
  menu; it toasts like the title menu's snooze, since the snooze closes the tab) and Clear
  (held while pending, no toast). Both docks (ThreadPane, InlineThread) already mount the strip
  keyed by thread.

## Differences from the sketch

- The sketch draws the row's actions on line 3 with Woke still showing; they sit in line 1's
  hover slot over the status, as Snooze and Archive do today (asked for explicitly).
- In the strip the whole sentence is amber; the sketch had " · 2m ago" in the plain colour.
  It reuses the status text as one sentence, as the brief asked.
