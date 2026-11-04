# Save for later, PR 2 of 2: the GUI

Stacked on `save-for-later-1-daemon.md` (`saved_at`, `thread.snooze --save`). Design: option A
from the renders the user approved.

## What was built

* `ThreadView.savedAtMs`; `lib/snooze.ts isSnoozed` is "put away in either form". Readers
  that ask that question moved to it: `lib/tree`, `stores/threads attentionIds`,
  `stores/archiveCleanup`, `stores/snoozeDialog`, `lib/lineage`, `lib/tagCandidates`,
  `ThreadMenuItems`. `lib/thread isRunningThread` checks the field itself, and
  `useCollisions` reads through it. `snoozedUntilMs` stays a time, so time labels needed
  no guard.
* Snooze submenu: "Save for later" with the muted hint "No alarm", after "Pick a date and
  time" below the separator. The row menu, the header menu and the row's hover menu share
  `SnoozePresetItems`, so all three have it.
* Sidebar: saved threads stay in Snoozed and count in its number. `tree.ts` sorts timed
  threads first (soonest wake), then saved ones, most recently saved first. The row shows a
  Bookmark and "Saved" where the countdown goes. The list key carries `savedAtMs`.
* Words: the composer note says "Saved for later" with Unsnooze; tag info says "Saved";
  Ember's worker rows say "Saved" (`EmberTaskThread.saved`, proto 17) and the text the
  model reads says "saved for later" (`ember.ThreadState`).
* Mock: `MockThread.savedAt`, `saveThread`, `thread.snooze` `save`, `POST
  /__mock/thread/snooze?id=&save=true`. The default world is unchanged, so no spec's order
  moved.
* `pages` skill `sources.md` lists `savedAtMs`, so a board can filter saved threads out.

## Choices made here (beyond the brief)

* **Save for later is in the snooze dialog too.** The palette's `thread.snooze` presenter
  opens that dialog, so this is how the palette reaches it. A thread already saved shows
  "Saved for later" there instead of the button.
* **The item is left out for a thread already saved**, as the thread menu leaves out what
  a thread cannot use.
* **The hover card adds nothing.** The row already says Saved, and CLAUDE.md forbids a
  tooltip that repeats what is on screen. The card never showed a wake time, so it cannot
  show a wrong one.
* **"Unsnooze" stays the word** on the menu item and the note's button for a saved thread:
  the thread is in the Snoozed section, and it matches `--clear`.
* **`lineageStatus` returns "snoozed" for a saved thread.** It only feeds `childRowState`,
  which folds it to "done", so the word is never shown.
* **A move between a time and saved is not a transition** for `archiveCleanup`: the thread
  was already put away, so its panels are left alone.

## Verification

Live on a real `daemon --dev` with a scratch home, two real Claude threads and WebKit: the
row menu's Snooze submenu listed "Pick a date and time" then "Save for later No alarm";
picking it set `saved_at` with `snoozed_until` 0; the section read "Snoozed 2", with "Timed one
1h" above "Keep for later Saved"; `--clear` from the CLI moved the row back to the main list
live, and the section read 1.

`make check` green, `make gui-e2e` run in full. New vitest cases in
`lib/tree`, `lib/snooze`, `lib/thread`, `lib/ember`, `SidebarRow`, `ThreadMenuItems`,
`SnoozeNote`, `SnoozeDialog`, `archiveCleanup`, `snoozeDialog`, `threadActions`, `threads`.
`e2e/snooze.spec.ts` gains one flow across the daemon's stream, and a SHOTS-gated spec makes
the PR's screenshots.

## Gotchas

* `. .playwright/drive.env` sets `CODE_FOUNDRY_HOME` in the shell but does not export it, so
  a later `bin/code-foundry` call does not see it and goes to the real home, even though
  `echo $CODE_FOUNDRY_HOME` prints the scratch path. Pass it on the command line of every
  call, or use a wrapper that hard-codes it.

## Daemon restart

Yes: PR 1's migration, plus `EmberTaskThread.saved` here.
