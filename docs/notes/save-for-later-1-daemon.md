# Save for later, PR 1 of 2: daemon, command, API

A snooze with no wake time. The user approved the design from rendered options (option A):
the Snooze submenu gains "Save for later", and a saved thread stays in the Snoozed section.
PR 2 (`save-for-later-2-gui.md`) is the GUI. Builds on `snooze-threads-1-daemon.md`.

## Storage: an explicit `saved_at`, not a far-future `snoozed_until`

`threads.saved_at` (migration 0057, unix ms, 0 when not saved), `Thread.SavedAt`, proto
`Thread.saved_at` (76, unset when not saved). A saved thread has `snoozed_until` unset.

Why: a sentinel date would need every reader of `snoozed_until` as a time to special-case
it, and a missed one shows a nonsense date (the wake loop, time-left labels, `snoozed
until:` in `thread detail`, the disconnected page). With a separate field those readers
stay correct untouched, and the ones that mean "is it put away" move to one helper. It
costs one column. A timestamp over a bool costs nothing more and gives the saved rows an
order, as `archived_at` does.

`Thread.Snoozed()` is "put away in either form". Use it for that question and
`SnoozedUntil` only for the wake time. Readers changed: `unsnoozeLocked`, the startup
"snooze ended" settling in `New`, the background-run kill (`daemon/actions.go`),
`liveWorktrees`. `wakeSnoozed` is unchanged: it skips a zero `SnoozedUntil`, so a saved
thread never wakes, at startup or on the tick.

## Behaviour

* `Store.SaveForLater(ctx, id)` shares `putAway` with `Snooze`: refuse a resident thread,
  close, remove shells, then under `m.mu` refuse a thread a Reconnect won, set the field,
  unpin, clear a "snooze ended" status, unarchive.
* Saving a saved thread keeps `SavedAt`, as archiving an archived thread keeps
  `ArchivedAt`, so it does not jump in the list.
* The two forms replace each other: a timed snooze clears `SavedAt`, a save clears
  `SnoozedUntil`.
* `unsnoozeLocked` clears both, so Reconnect, Pin(true), Send, Archive(true) and
  `Snooze` with a zero time all end a save, with no attention.

## Surface

* API: `SnoozeThreadRequest.save` (3). With `until` it is InvalidArgument. Neither still
  unsnoozes.
* Command: `thread.snooze --save`, a flag beside `--clear` rather than an `--until` value,
  because it is not a time: `until` keeps meaning one, and the three are exclusive
  (`snoozeRequest`). `snoozeArgs` became `snoozeRequest`, so Run and the confirmation build
  the same request.
* Confirmation as a snooze, in its own words: "Save thread X for later? Claude is still
  working; saving ends the turn." Result: `saved thread X for later`.
* `thread list` marks it `saved`; `thread detail` prints `saved for later`, no date.
  `--clear` on a saved thread reports `unsnoozed thread X`, the verb the flag documents.

## Verification

See the PR body for the run. `make check` green. Go tests:
`internal/store/thread/save_for_later_test.go` (the put-away table, restart, keeping the
time, ten years on with no wake at the tick or at startup, every way to clear it, the
woken status), `TestThreadSnoozeSave` (API), `TestThreadSnooze` (command rows),
`liveWorktrees` and the background-run kill.

## Daemon restart

Yes: new field, migration 0057, new request field.
