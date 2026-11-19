# Snoozing a thread no longer tears it down

A snooze used to cost too much: it stopped Claude's process (cutting a turn off), ended the
thread's terminals (they came back as fresh shells with "Run again") and unpinned it, and so it
asked for confirmation mid-turn. A user wants to snooze freely so Active holds only what they are
working on. Now a snooze (until a time, or saved for later) only hides the thread until later.
Archive is unchanged: it still closes the process and ends the terminals.

This builds on `snooze-holds-archive-refuses.md` (a snoozed thread can work and stay snoozed,
under Needs you while it asks) and corrects `snooze-threads-1-daemon.md`,
`save-for-later-1-daemon.md`, `self-put-away.md` and `shell-model.md` where they describe the
teardown.

## What a snooze does now

* **Thread store** (`internal/store/thread/snooze.go` `putAway`): refuses a resident thread, a
  hold (`holds.go`) and a thread setting up, as before; then, under `m.mu`, drops an archive the
  thread asked of itself for its turn's end (the later put-away wins), sets `SnoozedUntil` or
  `SavedAt`, unarchives it, clears an earlier wake's "snooze ended" and commits. No `Close`, no
  `removeShells`, no unpin, no `record.away`. The idle stop stops a snoozed thread's process at its
  prompt cache expiry like any other's; it stays snoozed.
* **Wake** (`wakeSnoozed`): clears the time; a stopped thread gets NEEDS_ATTENTION "snooze ended"
  as before. A thread whose process runs is marked on its runner (`setSnoozeEnded` →
  `threadCmd.snoozeEnded` → `streamStatus.snoozeEnded`), only when Claude is at its prompt: a
  working thread keeps its status (unchanged rule). The runner's status keeps it until a message
  or a turn starts (`sent`, `turnStarted`), Clear (`ClearSnoozeEnded`, now routed to the runner) or
  another snooze; seeing the thread does not clear it, as it does not on a stopped thread. When
  the idle stop then stops it, the saved status is "snooze ended", as a stopped wake's.
* **Self snooze** (`PutAwaySelf`): a snooze or save of itself happens at once, even mid-turn.
  Deferring existed because the close killed the Bash call that asked; with nothing closed there is
  nothing to wait for. Only an archive of itself still waits for the turn's end.
  `SnoozeThreadResponse.deferred` stays in the proto, always false.
* **No confirmation**: `thread.snooze` lost its `Confirm`/`ConfirmIf`/`DynamicConfirm`, single and
  `ids` (`snoozeConfirm`, `snoozeManyConfirm` gone). The GUI's dialog was the daemon's question,
  so it is gone with it, and with it `thread.snooze.default`'s (cmd+shift+s,
  `put-away-chords.md`), which takes whatever `thread.snooze` asks. Archive and remove keep theirs.
* **Action runs** (`internal/daemon/actions.go`): no longer killed on a snooze; an archive and a
  removal still kill them.
* **Shells**: `ShellsSnoozed` is gone; `Options.ShellsGoing` hears only of archives and removals.

## Tabs (layout)

* `snooze_thread` (`internal/layout/thread.go`) is now `close_thread` without the reopen record:
  the thread's tab and its linked tabs in its space close, the linked tabs join its remembered set,
  their terminals and the quick terminal keep running (nothing marked fresh, nothing in
  `Result.Ended`). Its terminal tabs in other spaces stay open, as a close leaves them. Where the
  tab was is kept in `ThreadState.SnoozedTab` (space, pane, index, active, and where the pane sat
  when it was its only tab). The op's `ran`/`quick_ran` are ignored (kept in the proto).
* `set_snoozed` off (the wake, an unsnooze, the user's message): when the thread's tab is open it
  restores the set beside it as before. When it is not and a snooze closed it, the tab goes back:
  into its old pane at its old index while that pane is in the thread's space and has room; into
  the pane rebuilt beside its old neighbours when it was the pane's only tab; otherwise where
  `open_thread` puts a thread's tab. Then the set comes back as an open restores it. Opening the
  thread's tab while snoozed forgets `SnoozedTab` (the wake finds it open).
* The glue (`internal/daemon/layout.go`) applies `snooze_thread` on the thread's `Updated` that
  first reads snoozed (when the layout does not mark it yet), instead of from `ShellsGoing`.
* Layouts saved by an older build may hold terminals marked fresh and a quick terminal marked
  fresh: restore still starts fresh shells for those, so the Fresh/FreshQuick paths stay.

## Choices made here (where the brief was silent)

* **Every unsnooze puts the tab back**, the time arriving included, not only an explicit undo: the
  brief restores them "when the thread stops being snoozed". The glue cannot tell an undo from a
  wake, and a woken thread coming back where it was matches "hide until later".
* **The wake never takes the focus.** The tab is the active tab of its pane again if it was,
  except in the focused pane, whose front tab stays (`show` without focus). So an Undo leaves the
  tab back but not focused; the Undo toast can follow with `thread.open` to focus it.
* **A snoozed thread's preview still shows only its conversation** (no set restored while
  snoozed), as before; its set comes back beside it at the wake.
* **No pin on Snoozed rows**: a snoozed pinned thread keeps `Pinned`, lists under Snoozed with no
  pin glyph (the row never had one), and returns to the pinned rows when it wakes. Pin, the user's
  message and archive still clear a snooze; Unpin on a snoozed thread only unpins.
* **Setting up still refuses a snooze**, unchanged; nothing about it conflicts any more, but
  lifting it was not asked for.
* The mock daemon mirrors it: no stop, no shell or run kills, pin kept, no confirm, the tab
  closes on a snooze (as the mock's `close_thread`) and comes back at the wake, a live thread at
  its prompt wakes "snooze ended".

## Tests

* Store: `TestSnooze`, `TestSaveForLater` (process, shell, pin kept; archived unarchived),
  `TestSnoozeUndo` (snooze and save, then `--clear`: same process, status, pending request, pin,
  shell; at its prompt, asking, working, stopped), `TestSnoozeWakesALiveThread` (the runner's
  "snooze ended", Clear, re-snooze, a message), `TestIdleStopSkipsStopped` (the idle stop stops a
  snoozed and a saved thread, which stay snoozed), `TestSnoozeStatus` (status untouched, nothing
  published "interrupted" or "snoozed"), `TestPutAwaySelfSnoozeAtOnce`,
  `TestPutAwaySelfSecondReplaces`, `TestPutAwaySelfOverruledByTheUser`, `TestShellsGoingBeforeTheShellsGo`.
  `e.snoozed()`/`e.saved()` now stop the thread first, so the wake tests keep their stopped case.
* Layout: JSON cases `snooze_thread-*`, `set_snoozed-wake-puts-the-tab-back`,
  `-rebuilds-the-pane`, `-moved-space`; `TestQuickTerminalAcrossASnooze` and
  `TestQuickTerminalAfterAnOlderSnooze`.
* Daemon glue: `TestLayoutGlueSnoozeAndUndo` (tabs close, terminals run, the undo restores the
  same tabs over the same terminals), `TestLayoutGlueSnoozeKeepsActionRuns`,
  `TestLayoutGlueWakeRestoresTheSet`; the fresh-shell race tests now start from an older build's
  layout (`olderSnooze`). `TestActionCleanupNeverKillsAtASnooze`.
* Commands and API: no confirmation single or `ids`, a thread snoozing itself is done at once.
* Frontend: `lib/shellSections.test.ts` (a pinned snoozed or saved thread under Snoozed, back with
  the pinned when it wakes), `mock/world.test.ts` and `mock/bulkThreads.test.ts` (no question,
  nothing torn down, the round trip, the live wake, the tab back).
* No new e2e: nothing browser-only changed. `shell-quick-snooze.spec.ts` (SHOTS only) seeds an
  older build's layout and still holds for it; its comment says so.

## Daemon restart

Yes: daemon behaviour, a layout field (`snoozed_tab`) and proto comments; no migration.
