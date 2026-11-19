# Auto-tidy: idle threads saved for later, saved threads archived

A user wanted the sidebar's Active list to hold only what they work on now, without tidying by
hand. Two settings (General › Threads, after Default snooze), both off by default, let the daemon
step idle threads down: Active → Snoozed (saved for later, no alarm) → Archived. Nothing is ever
deleted. Builds on `snooze-without-teardown.md` (a save closes nothing; an archive closes the
process and ends the terminals), `save-for-later-1-daemon.md` and `archive-threads-1-daemon.md`.

## Settings

| Key | Values | Says |
| --- | --- | --- |
| `threads.auto_save_after` | `off` (default), `1d`, `3d`, `1w`, `2w`, `1mo` | "Save idle threads for later": a thread with no activity for this long (no message to or from Claude) moves to Snoozed with no alarm. Pinned threads, and threads that are working or asking, stay. |
| `threads.auto_archive_after` | `off` (default), `1w`, `2w`, `1mo`, `3mo` | "Archive saved threads": a thread that has sat in Snoozed with no alarm or event for this long is archived. Its work is kept. |

`settings.TidyAfter` reads a value (a month is 30 days). Both are read on every tick, so a
change applies at the next one.

## The clock, and why the words say "activity"

The first step's clock is `Thread.LastActivityAt`, which moves on: the thread's creation, each
start of its process (a message, an MCP refresh, a move, the setup), every message sent to Claude
(the user's, another thread's, a wake), the user's answer to a permission or question, and every
line Claude's stream writes. Looking at a thread does not move it: the app does not know when a
thread was last looked at, so nothing says "opened". It is more than messages (a process start
without one counts), so the setting and the card say "activity", glossed as "no message to or
from Claude".

A second clock, `Thread.ReturnedAt`, is when the thread last came back to the list from Snoozed
or Archived: any unsnooze (Dismiss, pin, the user's message, an archive ending it), a snooze's
time arriving, an unarchive. The idle clock starts no earlier. Found end to end: without it, a
user who took an auto-saved thread back out of Snoozed had it saved again at the next tick (30 s),
since unsnoozing is not activity. Same for unarchiving an old thread.

The second step's clock is `SavedAt`, by the user or the first step.

## The rules (`internal/store/thread/autotidy.go`)

`TidyRefusal`/`TidyAtRest` (pure, on a `Thread`): the user's own thread (not resident, no plugin
`Owner`, `InSidebar`, so a child whose creator was removed counts as the user's, as the sidebar
has it), not being removed, and at rest: connected or disconnected (not starting or closing), its
setup done, `StatusIdle` with a reason that is not "waiting…", no pending request, no wake pending,
no background shells or background subagents running, no move or reseed pending. Everything that
needs the user is `NeedsAttention` (asking, finished and not seen, marked unread, snooze ended)
or `StatusError` (interrupted, crashed), so those stay. A status not known is not at rest.

* `AutoSaveDue`: at rest, not archived, snoozed, saved or pinned, `LastActivityAt` and
  `ReturnedAt` both before now − setting.
* `AutoArchiveDue`: saved for later (`SavedAt` set, `SnoozedUntil` zero: a timed snooze is never
  archived by this; `SnoozeEvent` nil: nor a snooze until an event), saved before now − setting,
  not pinned, and at rest (choice below).

The glue adds the one rule the store cannot see: an active notification naming the thread (its
thread or an action's) keeps it where it is.

`Manager.AutoSave` checks `AutoSaveDue` again under `m.mu` and does what `SaveForLater` does to a
thread at rest: `SavedAt` now, nothing closed, removed or unpinned (the layout glue closes its tab
on the `Updated`, as for the user's save), plus `AutoSavedAfter` = the setting's time.
`Manager.AutoArchive` checks `AutoArchiveDue` and calls `Archive(ctx, id, true)`, the user's
archive (the process closed, shells ended, the threads it created taken along).

## Meeting snooze until an event (`snooze-until-event.md`, rebased onto it)

A snooze until an event is a save for later (`SavedAt` set, no wake time) plus
`Thread.SnoozeEvent`. Auto-tidy treats it as a snooze that is waiting on something:

* The first step never saves it (it is already snoozed; `AutoSaveDue` also checks
  `SnoozeEvent` by name).
* The second step never archives it, however long ago it was saved, exactly as for a snooze
  until a time.
* Snoozing an auto-saved thread until an event makes it the user's: `SnoozeUntilEvent` drops
  `AutoSavedAfter` (keeping `SavedAt`, as the user's own save does), so the row shows the event's
  label and the hover card the event's sentence, never "Auto". The row and the card also give
  the event precedence on their own (`SnoozeLeft`, `TipAutoSaved`).
* The event ending the snooze (`endSnoozesLocked`) is a return to the list, like a snooze's time
  arriving: `ReturnedAt` is stamped, so the idle clock starts again from then.

## The mark

`Thread.AutoSavedAfter` (proto `Thread.auto_saved_after`, a Duration) is set only while the
daemon's own save holds: whatever clears `SavedAt` clears it (`unsnoozeLocked`: Dismiss, pin, the
user's message, archive), a timed snooze replaces it, and the user saving it again keeps the time
and drops the mark (it is theirs now). It is the setting's time, not the measured idle span, so
the card can say "after 3 days".

Storage: migration 0066 adds `thread_tidy (thread_id, auto_saved_after_ms, returned_at)`, a row
only while either is set, `ON DELETE CASCADE` with the thread. A table rather than columns on
`threads` so that the way back from 0061 (`internal/db/wayback/0061_layout.sql`) can drop it with
`IF EXISTS` and stay safe to run twice; SQLite has no `DROP COLUMN IF EXISTS`. Additive: no row
exists until auto-tidy or a return writes one, so nothing saved before reads as automatic.

CLI: `thread list` marks it `[saved automatically]`; `thread get` prints `saved for later
automatically, after 3 days without activity`; `--json` has `autoSavedAfter`.

## The tick and the bell (`internal/daemon/auto_tidy.go`)

`startAutoTidy` runs a pass at once (what fell due while the daemon was stopped or the Mac
asleep) and then every `thread.SnoozeCheckInterval` (30 s), comparing wall-clock times like the
snooze wake. It is its own loop in the daemon glue rather than inside the thread store's wake
loop: an archive can wait up to the close timeout per thread, which must not hold up wakes, and
the notification rule lives outside the store. Same interval, same wall clock.

Each pass that saved threads posts one card, source `threads` (`notification.SourceThreads`, a
host source: in `hostSources` and `verbSources`), key `auto-saved`: "3 idle threads were saved for
later", body "Under Snoozed: A, B, C and 2 more." (snapshot order, three names, an unnamed thread
by id), info level, not time-sensitive (no Dock badge or bounce), one action "Open settings"
(`view.settings --page general`, resolves). Archives post under `auto-archived`: "2 saved
threads were archived", "Under Archived: …". A post replaces the card under its key: in place
while it is active (no new toast), and after the user dismissed or acted on it, the old one is
retired first (`Retire`), so the same words arrive anew (the store keeps a closed card closed
for the same content).

A first enable, or an update to a build with the setting already on, can save many threads in
one pass: that is one card naming them, and the bell's count shows it even when the pass ran
before any window connected.

## Choices made here (the brief was silent)

* **Snoozed order is unchanged**: saved rows sort by `SavedAt`, newest first, whoever saved
  them, so an auto-saved row sits among the user's saved ones by when it was saved (usually on
  top, being the latest).
* **The card is this pass's batch**, not a running total: a later pass replaces it with its own
  threads. The Snoozed rows' "Auto" says the rest.
* **The second step requires the thread at rest**, not only saved: a saved thread that works
  because another thread wrote to it (the snooze holds) is not archived mid-turn; it is once it
  rests. Its clock still counts from the save.
* **A thread created by another thread whose creator was removed** counts as the user's (the
  sidebar's rule); one whose creator exists never moves.
* **The user's own save of an auto-saved thread** keeps its `SavedAt` and drops the mark.
* **No Undo toast**; the user unsnoozes or unarchives, which also restarts the clock.
* **Race windows**: `AutoArchive`'s check and the archive are not one step under the lock (the
  archive closes processes outside it); a user who unsnoozes in that moment finds it archived. A
  live thread's `LastActivityAt` is published at most every 15 s, far below a day.
* **Dev knob**: `CODE_FOUNDRY_DEV_TIDY_DAY=<duration>` with `daemon --dev` only makes one day of
  the settings that long and ticks every second; the marks and cards keep the settings' words.

## GUI

* `ThreadView.autoSavedAfterMs` (optional, null when not automatic).
* Snoozed row: the bookmark and "Auto" where a saved row says "Saved" (`SavedMark`,
  `data-auto`). Hover card: "Saved automatically after 3 days without activity" with a bookmark,
  after the status (`TipAutoSaved`, `lib/autoTidy.ts`).
* `sourceLabel("threads")` is "Threads".
* The settings rows are the schema's dropdowns; nothing GUI-specific.
* Mock: both settings, `MockThread.autoSaved` (holds while `savedAt` is that save) and
  `returnedAt`, and `POST /__mock/auto-tidy?days=N` (one pass as if N more days had passed;
  `mock/autoTidy.ts`).

## Tests

* Go: `TestAutoTidyRules` (every exemption for both steps, the limits, the return clock),
  `TestAutoSave` (marked, persisted across a restart, a pinned or not-yet-due thread left),
  `TestAutoSavedMarkCleared` (unsnooze, the user's save, a timed snooze, pin, archive, a message;
  across a restart), `TestAutoArchive` (user and auto saves archived; timed snooze, pinned, a
  recent save left), `TestAutoTidyClockRestartsOnReturn` (unsnooze, unarchive, a wake; restart);
  daemon `TestTidyPlan` (notification and action naming), `TestTidyCard`, `TestAutoTidyOff`,
  `TestAutoTidyOneCardPerTick` (one card, replaced in place, anew after a dismissal),
  `TestAutoTidySettingsChange`, `TestAutoTidyAtStart` (the start pass, the dev day); the event
  snooze cases in `TestAutoTidyRules` (neither step), `TestAutoSavedMarkCleared` (snoozing until
  an event drops the mark), `TestAutoArchive` (an event snooze, auto-saved or not, stays) and
  `TestAutoTidyClockRestartsOnReturn` (the event ending it); settings
  `TestAutoTidySettings`, `TestTidyAfter`; command `TestAutoSavedWords`; the way-back test drops
  `thread_tidy`.
* vitest: `SidebarRow.test.tsx` (Auto vs Saved, the card's sentence and place, an event's label and sentence over Auto), `SettingsPage.test.tsx`
  (the two rows), `lib/autoTidy.test.ts`, `lib/notifications.test.ts`, `mock/autoTidy.test.ts`.
* e2e: `e2e/auto-tidy.spec.ts` is SHOTS only (the screenshots); nothing browser-only to assert.

## End to end (2026-11-19)

`CODE_FOUNDRY_DEV_TIDY_DAY=5s DRIVE_HOME=/tmp/… make drive DAEMON=dev`, project-less Sonnet 5.5
threads replying "ok", in two runs (the first on an earlier shape of the migration, then numbered 0065, so the second started
on a fresh home).

* Run 1, three threads, one pinned, first step on: all three stayed while Done and not seen. Once
  each was seen in the GUI, the two unpinned ones were saved on two passes (`[saved
  automatically]`; one card, replaced in place); the pinned one stayed; their tabs closed.
  `thread get` printed "saved for later automatically, after 1 day without activity". This run
  found the re-save after an unsnooze, hence `ReturnedAt`.
* Run 2, two threads, seen: one pass saved both ("2 idle threads were saved for later").
  `thread snooze --clear` on one: still in Active 3 s later, saved again after one setting-day,
  the card replaced in place (same id). Second step on (1 week = 35 s): both archived 35 s after
  their saves, one card per pass ("1 saved thread was archived"). The bell's Open settings opened
  Settings on General and resolved the card.

A daemon restart is covered by the store tests, not repeated live.

## Daemon restart

Yes: migration 0066, a proto field, new settings and a daemon loop.
