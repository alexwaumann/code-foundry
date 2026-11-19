# Threads open as, part 3: Panes by default for new homes only

Parts 1 and 2 (`threads-open-as-1-rules.md`, `threads-open-as-2-gui.md`) built the setting
`layout.threads_open_as` with Tabs as its default. This part makes Panes the default of a new
home, keeps every existing home on Tabs, and tells an existing home once that Panes exists.

## What is written to disk, and when

- **A new home** (no database yet): nothing is written to the settings file. The schema default
  is `panes`, so it starts on Panes. The marker file beside the settings file
  (`settings.toml.cleared`) gets the line `layout.threads_open_as-panes-2026-11`.
- **An existing home whose settings file does not set the key**, at the first start of a daemon
  with this change: `layout.threads_open_as = "tabs"` is written into `settings.toml` through the
  store's normal save (`Store.Update`, the same rendering every save from the app does: the user's
  values and unknown keys kept, the commented defaults re-rendered; hand-written comments are not
  kept by any save, this one included). The marker gets
  `layout.threads_open_as-panes-2026-11.notice` before the write and
  `layout.threads_open_as-panes-2026-11` after it; once the bell has the notice,
  `layout.threads_open_as-panes-2026-11.noticed`.
- **An existing home whose file sets the key** (any value): nothing is written; the marker gets the
  decided line.
- **Every later start**: the decided line is there, so the key is never looked at again.
- **Undo**: the value is the user's like any other. Settings › Appearance › Panes and sidebar ›
  Threads open as, `settings.set layout.threads_open_as panes`, or deleting the line from the
  file (which then reads as the new default, Panes). Deleting the marker file makes the next start
  run the step again on a home with a database: a file that sets the key is left alone, and one
  that does not gets `tabs` written and the notice again.

## How it is built

- **Settings store** (`internal/store/settings/defaultchange.go`): a registry of default changes
  (`defaultChanges`: id, key, old default), beside the once clears (`once.go`), sharing their
  marker file (one id per line; an older daemon keeps lines it does not know). `KeepOldDefaults`
  runs each undecided change: a new home is marked decided; a file that sets the key is decided;
  otherwise the `.notice` line, then `Update(key=old)`, then the decided line. `DueNotices` lists
  the changes decided with a notice owed, not yet noticed, and the key still the old default;
  `MarkNoticed` records one posted.
- **Daemon** (`internal/daemon/default_change.go`): `openStores` calls `keepOldDefaults` right
  after the settings store opens, before the database is opened and before the layout store loads,
  so no op and no load ever sees Panes on an existing home (the layout store conforms a layout
  stored under another mode at load: that never happens here). After the notification store opens,
  `postDefaultNotices` posts what is due and marks it noticed. A failed post is owed again at the
  next start.
- **The notice**: source `app` (new: `notification.SourceApp`, shown as "Code Foundry", a host
  source no plugin may use, its command actions registry verbs), key `threads-open-as-panes`,
  level info, not time-sensitive (so no Dock badge or bounce), one action "Open settings" =
  `view.settings --setting layout.threads_open_as`, which does not resolve the card (as GitHub's
  Open PR). The words are the agreed ones.
- **`view.settings --setting <key>`** (new): opens the settings page on that setting's page (from
  the schema) and emits `ShowView settings.<page>` with the param `setting`. The GUI's `showView`
  then runs `openSettingAt`: the page, then `focusSetting` (the row's `data-setting`, scrolled to
  the centre, its editor focused) retried for up to 30 frames while the page draws. The same
  mechanism as the snooze-until-event branch's "Choose what shows here…" (`focusSetting`, 30
  frames); that one can move onto `openSettingAt` when both are on main.
- **Switch dialogs** ask in a new confirm tone, `neutral`: an info icon in the info colour and the
  plain primary button (`ConfirmDialog` `looks`). Part 2 used the default warning look; nothing is
  lost by the switch, so it no longer looks like one.
- **"(default)"** in the dropdown already followed the schema's `defaultValue` (`EnumEditor`); with
  the schema default now Panes it marks Panes. A vitest test pins that it follows whatever the
  default is.

## The existing-home signal

The database (`db.sqlite`) existing before this start. Every daemon start opens, and so creates, it,
so a home without one has never run a daemon; and the check runs before this start creates it.
Considered and not chosen:

- **A settings file that predates the key**: `settings.Open` creates the file on every start, and
  since part 1 the rendered file holds the key's commented default, so "the file predates the key"
  is not readable from the file. A settings file with no database is also what a dotfiles restore
  on a new machine looks like.
- **Threads or a stored layout in the database**: needs the database open first and a query per
  store; a home that ran the app without making a thread is still a home from before, on Tabs.
- **A schema version**: would need a migration only to read it; the database's existence says the
  same.

Edge cases:

- A start killed between deciding "new home" and opening the database: the decided line is written
  before the database is created, so the next start still sees a new home.
- A start killed after the `.notice` line but before the write: the next start finds the key unset
  and writes it. Killed after the write but before the decided line: the next start finds the key
  set, marks it decided, and the notice is still owed.
- A home whose user deleted `db.sqlite` but kept `settings.toml` (a reset): a new home, Panes.
- A settings file copied onto a new machine (no database): a new home; its own key, if set, wins.
- A file that sets the key to a value this build refuses (`grid`): the user set it, so it is left
  alone, and it reads as the default as every refused value does, now Panes.
- The marker file deleted by hand: see Undo.
- A marker write that fails (a read-only home): the step still runs and is remembered for the run;
  the next start finds the key set (decided, no notice) or unset (tries again).

## Write failures

A settings file that does not parse (`Update` refuses), or that cannot be written (a read-only
directory, a managed file): nothing is recorded, the old default is **held in memory** for this run
(`Store.held`), and the next start tries again. Held means: every snapshot the store publishes
resolves the file's values with the held one added for a key the file does not set, so
`Settings()`, the snapshot's `Values` and so the GUI and the layout store all say Tabs. It is never
written by a save of another setting (the file is written from the file's own values, not the
resolved ones), a reload of the file keeps it, and a value the file sets, or the user picks, wins
over it. The daemon does not crash and logs a warning naming the change. While held, the dropdown
shows Tabs with the reset arrow (it differs from the default), and resetting it keeps Tabs for the
run: the key is then unset and the held value applies.

## Downgrade

An older daemon reading a file with `threads_open_as = "tabs"`: daemons since part 1 know the key.
Daemons before it keep an unknown key in the file under an "Ignored" comment and report it as an
issue; they do not fail (`render`, `file.go`). The marker lines are kept by any daemon that writes
the marker file (it rewrites every id it read).

## Mock

`POST /__mock/reset` is a new home: the mock schema's default is `panes` (the daemon's), the
layout is empty. `POST /__mock/install?state=existing|fresh` plays the daemon's first start after
the change: `existing` writes `tabs` when the key is unset and posts the notice; `fresh` does
nothing; once per reset (`World.simulateInstall`). The mock's `view.settings` takes `--page` and
`--setting`, and its notification act runs the `app` source's command actions as registry verbs.

## Tests

- Go: `internal/store/settings/defaultchange_test.go` (new home, existing with the key unset,
  each value set, second start, write failure, a file that does not parse, killed before and after
  the write, noticed, the rest of the file kept, the held value across reload and saves);
  `internal/daemon/default_change_test.go` (the start sequence on a real database: posts once,
  failed post retried, a later switch to Panes cancels the notice; the notice's source, key, words
  and action, and the store taking it; a layout stored under Tabs loads unconverted);
  `internal/command/commands_view_settings_test.go` (`--setting`).
- Vitest: the neutral dialog (`ConfirmDialog.test.tsx`), the switch questions' tone, the default
  marker following the schema, `showView` with `setting`, the `app` source label, the mock control.
- e2e: `threads-open-as-default.spec.ts`, the notice's Open settings landing on the focused row in
  the real sheet; SHOTS for the notice, the row and the dropdown's marker.

## End to end

`make drive DAEMON=dev` on two scratch homes. A new home: `settings get layout.threads_open_as`
says panes, the file has only the commented default, the marker the decided line, the bell
nothing. A home started once, then made to look like an older build's by hand (the marker line
removed, the key unset, a font size of the user's set): the next start wrote
`threads_open_as = "tabs"` beside the font size, recorded all three marker lines and posted the one
notice; its Open settings in the GUI opened Settings on Appearance with the row focused on Tabs and
left the notice in the bell. A third start changed neither file (same bytes) and posted nothing.

## Gotchas

- `TestConvertLayoutOnModeChange` and 46 e2e specs relied on the old default (the thread's own
  header, strips of several thread tabs, tab drags, a page tab in the thread's pane). They now set
  Tabs after the reset (`threadsOpenAsTabs` in `e2e/fixtures.ts`): what they test is Tabs. Vitest
  needed nothing: the GUI's tests set the setting they read.
- A dev daemon's home under the session scratch directory is too long a path for its socket (macOS
  allows 103 bytes): drive on a short `/tmp` home.
- The mock remembers the mode it last converted to; a reset now sets it to the new default, which
  the empty layout already conforms to, so a spec's first switch to Tabs converts nothing.
