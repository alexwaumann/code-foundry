# Put-away chords

A user wanted putting a thread away to be one keypress, so the sidebar's Active list keeps to
what they are working on. Three keys and one menu item:

| Key | Command | Does |
| --- | --- | --- |
| cmd+shift+a | `thread.archive` | archives the thread in view (a toggle, as the command always was: on an archived thread it unarchives), with the confirm it has |
| cmd+shift+s | `thread.snooze.default` | snoozes the thread in view to the default snooze |
| cmd+shift+n | `thread.needs.next` | the Needs you popup of the next thread that waits (was cmd+shift+a) |

and the sidebar's bulk menu gains Mark as unread.

## The Needs you jump is a command now

cmd+shift+a was a reserved GUI view action (`viewActions` in `keys/bindings.ts`,
`ReservedChords` in `internal/command/chord.go`), not a registry command. It moved to
cmd+shift+n as `thread.needs.next` (category View, `NoIndex`, `commands_view_needs.go`), like
`thread.next`: a window presents it locally (`commandPresenters`), the CLI's reaches every window
through ShowView `needs.next` (`stores/views.ts`). So the palette lists it, Keyboard Shortcuts
shows it from the command list, a user can rebind it, and the native Thread menu's "Next Thread
Needing You" names the command (`gui/menu.go`; the `attention.next` view action is gone).

What a command chord does differently from the view action, on purpose:

- It yields from a focused text field only because it is in `fieldYielded`: the popup's reason
  field keeps cmd+shift+n going to the next popup, as before.
- It does nothing while the palette is open (every command chord does).
- From a terminal or the thread prompt it reaches the command like any cmd chord bound to one.
- Pressed before the first command list it waits for it (`startWhenListed`); the old view
  action's "before the first draw" case still works through `openNextNeedsPopup`.
- From the menu with nothing waiting before the window's first draw it still toasts "No threads
  need attention"; otherwise nothing visible, as before.

`TestShellKeyTable` and `keys/shellKeys.test.ts` read the spec's key table
(`shell-model.md`, "Keys"): its row is now cmd+shift+n → `thread.needs.next`. Older notes that
say cmd+shift+a for the jump are history.

## Snooze to default

- Setting `threads.default_snooze` (General › Threads, a dropdown after "New threads work in"):
  `1h`, `3h`, `tomorrow` (default), `next-week`, `save`. The values are `command.SnoozeDefaults`,
  the menu's presets plus save, each a form `parseSnoozeUntil` reads as the menu means it.
- A separate verb, `thread.snooze.default`, not `thread.snooze` with no time: a bare
  `code-foundry thread snooze` still says to give until, save or clear. Its `to` arg's default
  is the setting, through `Overrides.ArgDefaults` (`registryOverrides`, like the thread
  starters' model and effort); a value the arg does not take falls back to tomorrow.
- It is built from `thread.snooze` (`threadSnoozeDefault` wraps its Run, ConfirmIf and
  DynamicConfirm with the preset as until or save), so whatever `thread.snooze` asks or refuses,
  this does too, with no copy of its rules to keep in step.
- The window's presenter (`stores/snoozeDefault.ts`) computes the preset's time as the menu does
  and runs `thread.snooze` through `snoozeThread` / `saveThreadForLater`, toasted (the key
  leaves nothing on screen that says where the thread went). So the chord is a menu pick.
- The snooze menus (`SnoozePresetItems`: row menu, header menu, the row's alarm menu, the bulk
  menu) put a quiet "default" and the chord (as the user bound it) after the default item's
  label; the time stays right-aligned. The bulk menu shows "default" without the chord: the
  chord acts on the thread in view, not the selection.

## Mark as unread in the bulk menu

`thread.unread` takes `ids` like `thread.archive` / `thread.snooze` (`unreadThreads`: each in
turn, past one the daemon refuses, which is named, exit 1). The bulk menu offers it only when
every selected thread passes `lib/markUnread.ts` (`bulkMenuItems().unread`), after Unsnooze, and
runs one command (`markThreadsUnread`). No toast: the rows show Done.

## Users' own bindings of these chords

`Command.KeybindingsYield` marks a default given to a chord users could already bind
(cmd+shift+n and cmd+shift+s were free; cmd+shift+a was reserved, so an override on it was
refused and kept in the file as an issue). `resolveKeybindings`:

- An override that binds such a chord to another command wins; the yielding command goes
  without it. Its value reads "none", the registry gets it unbound, the file is not touched.
  No issue: an issue means "a value in your file is ignored", which the CLI's settings warning
  and the file's `# Ignored:` lines say, and none is.
- An override of the yielding command's own takes it back.
- Two overrides on the chord collide with each other as before (both dropped), and the yielding
  default keeps the chord.
- Every other default still wins over a colliding override (`TestStaleKeybindingOverrides`).

So a user with `"thread.new" = "cmd+shift+n"` keeps it, and the Needs you jump has no chord
until they give it one; a user who had tried `"x" = "cmd+shift+a"` (refused as reserved) now has
it, and archive has no chord. Nothing is ever on two commands.

Users who press cmd+shift+a out of habit now archive the thread in view.

## Verified

- `internal/command` (snooze default, unread ids, needs.next ShowView, key table), settings
  `TestResolveKeybindings`, daemon `TestPutAwayChordsKeepUserOverrides` (a real settings file).
- vitest: `keys/bindings.test.ts` (cmd+shift+n, from a field, rebound), `stores/snoozeDefault.test.ts`,
  `components/snooze/SnoozeMenu.test.tsx`, `lib/bulkMenu.test.ts`, `ShellSidebarList.test.tsx`,
  the mock's `bulkThreads.test.ts`.
- e2e `put-away-chords.spec.ts`: both chords through the keymap.
- A dev daemon on a scratch home with `"thread.new" = "cmd+shift+n"` and
  `"view.usage" = "cmd+shift+a"`: `settings get` showed both kept, `thread.needs.next` and
  `thread.archive` "none", no warning; `thread unread --ids` on two idle threads, then on one
  already unread (failed, exit 1); `thread snooze default` (until tomorrow 9:00 AM), then with
  `threads.default_snooze = save` (saved for later); `settings set threads.default_snooze soon`
  refused.

Gotcha: a `CODE_FOUNDRY_HOME` under the scratchpad's long path makes the socket path longer
than macOS allows (103 bytes); use a short `/tmp` home for a dev daemon.
