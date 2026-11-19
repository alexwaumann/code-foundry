# An Undo toast after a put-away, and the pane a put-away keeps

A user wants putting a thread away to feel safe and take one gesture. Since a snooze no longer
tears a thread down or asks first (snooze-without-teardown.md), the safety net is an Undo. And
putting away the thread a pane showed should not rearrange the window: the pane stays.

## The Undo toast (stores/putAwayUndo.ts)

* **When.** After this window's user snoozes (a time, the default chord, Save for later) or
  archives one thread or several, by any GUI path. It hears of them through a watcher on the command
  runner (`watchCommands` in stores/commands.ts): `runCommandForResult` calls each watcher before
  the command runs, without a `caller`, so plugins and pages never count; a watcher returns what to
  do on success. Every GUI path (row buttons, row/header/tab menus, the bulk menu, chords, the
  palette, drops on the Snoozed and Archived headers) goes through it, so no call site changed.
  The CLI, another window, a thread's own put-away and auto rules never reach this window's runner:
  no toast. A failure or a declined confirmation calls nothing.
* **What.** `putAwayOf(name, args, ctx)`: `thread.snooze` with `until` or `save` (not `clear`);
  `thread.archive` with `archived` true, or without it (the toggle: archive one thread unless it is
  archived now; several always archive). `descendants-of` is left out (nothing a GUI path sends).
* **Its success toast is replaced.** The watcher's answer returns true and the generic success
  toast is skipped (toast-success-rule.md: rule 3, a next step).
* **The card.** Through `lib/notify` and sonner, no new component. `notify` gained, for every
  toast: `level: "neutral"` (the plain card, sonner's level-less `toast`), `icon`, `position:
  "bottom-left"`, `onClose` (sonner's onDismiss and onAutoClose) and `NoticeButton.chord`, drawn
  after the label quieter (`ml-1.5 font-normal opacity-70`, as FileEditBar draws one), in action,
  cancel and `buttons` rows alike. Icons: AlarmClock (snooze), Bookmark (save), Archive.
* **Position.** One Toaster: sonner draws a list per position, each with the Toaster's offset, so
  `offset={{ bottom: 20, right: 20, left: 20 }}` gives the bottom-left list the same 20px margins.
  No second Toaster. Sidebar open or a rail, it sits at the window's corner, over the sidebar's
  foot. No zoom compensation: like the bottom-right toasts, the offsets are CSS pixels.
* **Words.** Title "Snoozed until tomorrow, 9:00 AM" (`snoozeUntilPhrase`: "tomorrow, …",
  otherwise `snoozeTimeShort`: "3:12 PM", "Thu 9:00 AM", "Oct 19, 9:00 AM"), "Saved for later",
  "Archived"; several: "Snoozed 3 threads until …", "Saved 3 threads for later", "Archived 3
  threads". A snooze whose time the window cannot parse says "Snoozed". Description: the name
  (a thread without a name: its id, as the rows show it), "a and b", or "a, b and N more", in a
  `truncate` span. Names are read before the command runs.
* **Timer and close.** 5 s, `closable` (the X always shows). Sonner pauses the timer while the
  pointer is over a toast list (its `expanded`). Replacing a toast with the same id restarts its
  timer.
* **One at a time.** Every undo toast has the id `put-away-undo`; a newer one replaces the one
  showing and becomes what Undo undoes. The module keeps the put-away showing; the old toast's
  onClose does not clear the newer (it checks identity).

## Undo

* `thread.snooze --clear` / `thread.archive --archived false`, `id` for one, `ids` for several,
  quiet (the rows show it), in the first thread's context. Neither shows an undo toast.
* **Focus.** Before the command runs, the watcher records whether one of the threads' tab was the
  current space's focused tab. After a snooze's undo it waits (2 s at most) for the daemon to put
  the tab back, then `tab.focus` (the wake never takes the focus, snooze-without-teardown.md);
  after 2 s, `thread.open --focus`.
* **Archive.** An archive forgets the layout's state of the thread, so the window records where each
  thread's tab was (pane, index). After the unarchive it opens the tab there: in place of the empty
  composer now at that place (`open_thread` with `compose`, which the composer send already uses),
  else `thread.open --pane --index` (quiet; refused when the pane moved space), else plain
  `thread.open`. A thread with no tab open stays closed, as an unarchive leaves it. Its process and
  terminals the archive ended do not come back (accepted).

## Keys (keys/bindings.ts, "Key precedence" item 0)

While an undo toast shows, cmd+z runs its Undo and Escape closes it, before everything else: view
actions, a focused prompt or field, a terminal, the code editor and the palette. Only a keybinding
recorder (settings) still captures first: it records chords literally. With no undo toast both keys
do what they did. The native Edit menu's Undo item has cmd+z too; the page's preventDefault keeps
it from running, as for the other cmd chords the window handles.

## The pane a put-away keeps (internal/layout/keep_pane.go)

* `snooze_thread` and `archive_thread` close the thread's linked tabs first; then, when its own tab
  is its pane's only tab, `composerInPlace` puts the space's empty composer in its place: in front,
  in its MRU slot (so a focused pane keeps the focus, on New thread), the pane kept. A pane with
  other tabs shows its next one, as a close does. No other thread opens.
* A space has at most one empty composer. One open in another pane among other tabs moves here
  (as a pane's "+" moves it). One that is alone in its pane stays there and the thread's pane closes
  as before: the space already shows New thread, and moving it would close that pane instead.
* `SnoozedTab.Composer` records the composer's tab id. The wake (`snoozedBack`) puts the thread's
  tab in place of that tab while it is still an empty composer (`threadInPlace`); once typed in
  (a draft, same tab id) the thread's tab goes back at its old index, beside it. `Beside` is still
  recorded, for a pane the user closed meanwhile.
* A user's close (close_thread, close_tab, close_pane) still closes the pane: only put-aways keep it.
* It is the layout's rule, so it holds for the CLI and other windows. `archiveCleanup` no longer
  selects HOME once the layout has loaded: that opened a composer beside the thread's tab before the
  layout closed it. Before the layout loads, it still does.
* Under the "threads open as" Panes and Single modes (#830) a thread pane may hold a composer, so
  the rule applies unchanged.
* The mock mirrors it: `putAwayThread` (snooze in its space, archive everywhere, the composer in
  place) and `threadChanged`'s wake into the untouched composer. The mock's glue now also closes an
  archived thread's tabs (it did not before), as the daemon's ShellsGoing does.

## Choices where the brief was silent

* A put-away that empties a pane's strip only together with its linked tabs (thread + its diff in
  one pane) keeps the pane too: what counts is the thread's tab being alone once its set is out.
* A New thread tab that takes the place is the home composer (no project), or the space's existing
  empty composer with its params.
* A bulk put-away where several threads had tabs: only the focused one gets the focus back.
* `thread.snooze.default` reached without its presenter (no such thread in the window's list)
  shows no undo toast; with the presenter it runs `thread.snooze` and does.

## Tests

* Go: JSON cases `archive_thread-only-tab`, `snooze_thread-only-tab` (updated),
  `snooze_thread-open` (updated), `snooze_thread-only-tab-moves-the-composer`,
  `-composer-alone`, `set_snoozed-wake-replaces-the-composer`, `-beside-a-draft`;
  daemon `TestLayoutGlueSnoozeAndUndo` (the kept pane, then the same tabs back),
  `TestLayoutGlueArchiveKeepsThePane`.
* vitest: `stores/putAwayUndo.test.ts` (putAwayOf table, words, every path's toast and no
  success toast, no toast for a failure, a declined confirm, unsnooze, unarchive, a plugin;
  the fixed id; Undo's commands and ids; focus back; archive reopen in the composer's place or
  beside a draft; cmd+z and Escape with and without a toast, from a focused prompt),
  `components/ui/undoToast.test.tsx` (the real card: bottom-left list and its 20px, chord inside
  Undo, close button, hover pause), `mock/layout.test.ts`.
* e2e `put-away-undo.spec.ts`: the corner and margins (open, rail), cmd+z from the composer a
  snooze left, the archive's kept pane and cmd+z being the field's again; SHOTS make the PR's.

## Daemon restart

Yes: a layout rule and a field (`snoozed_tab.composer`); no migration.
