# Keybinding reset puts a command back on its default; a stale terminal.new "none" is cleared once

A user's cmd+t (New Terminal, `terminal.new`) did nothing, while it worked on other machines.
On Settings → Keybindings they reset the row to its default, and the reset left New Terminal
on nothing instead of cmd+T. We do not have their settings file.

## Root cause of the reset bug

The settings store resolves keybinding overrides against each command's default chords,
which `setSettingsCommands` (internal/daemon/settings_commands.go) takes from
`Registry.List`. `List` returns commands with the overrides already applied
(`Registry.effective`). At daemon start that did not matter: settings tell the store the
commands before the first `SetOverrides`. But the plugin store starts after settings apply,
and every plugin it starts (or enables, disables, reloads) calls `ReplacePrefix`, which
calls `setSettingsCommands` again. From then on the store's "defaults" were the user's
overrides:

- `"terminal.new" = "none"`: the field's default became `""`. The page showed the reset
  arrow ("none" differs from ""), its tooltip read "Reset to default (unbound)", and the
  reset (which removes the key from the file) left the page on "Add shortcut" and the
  snapshot on `""`. The file was right (no override) and so was the registry (cmd+t), but
  the page said New Terminal had no key until the next restart.
- `"terminal.new" = "cmd+y"`: the default became cmd+y, so the row was not "modified" and
  had no reset arrow at all.
- `"terminal.new" = "none"` with `"demo.other" = "cmd+t"`: resetting New Terminal let
  demo.other keep cmd+t (the store saw no collision with New Terminal's "default", which
  was nothing), while the registry gave New Terminal cmd+t too. Two commands on one chord;
  the window binds the first in list order.

Any user with at least one plugin installed hit this; without plugins the reset worked,
which fits "it works on other machines". The page (KeybindingsPage, `useSettingField`,
`ResetButton`) was right: it commits `""`, which the store treats as "remove the key", and
shows a command on its default as unmodified. It can only be as right as the default the
daemon gives it.

**Fix.** `command.Listed` carries `DefaultKeybindings`, the chords a command registered
with, and `setSettingsCommands` passes those. The store applies the overrides itself, as
it always meant to. The GUI's command list still gets the effective chords.

**Tests.** Go: `TestKeybindingResetAfterPluginStart` (internal/daemon) has a table of
reset cases after a plugin start: an unbound command, a rebound one, one whose default
another override holds (the other override is reported and dropped, the default wins),
and resetting that other command. The command reset is unavailable in the empty context
(like terminal.new). For each it checks the field default, the snapshot, the registry and
the file. Without the fix every case fails. Vitest: `KeybindingsPage.test.tsx` covers the
page side: a reset commits `""`, a row on its default shows ⌘T with nothing to reset.

## What left cmd+t dead in the first place

Until 2026-11-12 the shell window ran its keys from its own interim table
(`gui/frontend/src/shell/keys.ts`), ahead of the registry's bindings, so cmd+t opened a
terminal whatever the settings file said about `terminal.new`. Since the key table moved
into the commands' default keybindings (90669a9c7, 57035987a), an override from the classic
window takes effect again. File states that leave cmd+t doing nothing:

1. `"terminal.new" = "none"`. Reproduced: no chord in the registry. With a plugin
   installed, a reset then showed nothing (above). This is the only state that fits the
   report: a reset arrow that resets to nothing needs both an unbound New Terminal and the
   plugin bug. A rebound New Terminal has no reset arrow under that bug.
2. `"terminal.new" = "<another chord>"`, one no default now takes (a chord that is now
   another command's default, like cmd+shift+t or cmd+j, is reported and dropped, so
   New Terminal gets cmd+t back). Reproduced in Go: cmd+t is unbound, New Terminal is on
   the user's chord.
3. `"terminal.new" = "none"` plus another command on cmd+t, from a swap. If that command
   is gone (a retired classic-window verb), its override is reported "unknown command"
   and cmd+t does nothing. Not run as one case: it is case 1 for New Terminal, and the
   dropped override is what `TestStaleKeybindingOverrides` already checks.

The reset bug never wrote a bad state: a reset removes the key and never writes "none".
Only the page's display was wrong. Not reproduced: anything in the window itself
(`chordSupplied` binds terminal.new's chord even where the daemon lists it unavailable,
and its tests pass), and anything that could make cmd+t dead with no override of
terminal.new.

## The one-time clear

`internal/store/settings/once.go`: `onceClears`, a registry of values dropped once from a
user's settings, beside `retiredChords` (cleared on every read, for a value nobody could
want). `"terminal.new" = "none"` (in any spelling the keybinding parser reads as none) is
the first. A deliberate "none" written today looks the same as a stale one, so a marker
records that the clear is done: `settings.toml.cleared` beside the settings file (like
`settings.toml.lastgood`), one id per line.

- While the clear is pending, every load drops the value before validation: New Terminal is
  on cmd+t, no issue is reported, and the next save from the app leaves the key out. The
  settings file is not written on load; nothing else in it changes, and the next save
  rewrites it as any save does.
- It is done (id written to the marker) when a load reads the file and finds no stale
  value (never had one, or the user edited it by hand to something else), or when the app
  saves the file (`Update`). After that, a later "none" is the user's choice and is kept
  across restarts, whether set in the app, the CLI or by hand.
- A restart before any save clears the value again (the file still holds it). A
  missing settings file marks it done at once, so a new user never meets it.
- A file that does not parse (the last-good copy applies) never marks it done: the file
  may still hold the stale value.
- A failed marker write is logged. The process keeps the clear done; the next start
  clears again only if the file still holds the stale value.

Only "none" is cleared. A user who moved New Terminal to another chord in the classic
window still has New Terminal on that chord; clearing it would drop a binding that works,
and that state does not fit the report.

## Verification

- `go test ./internal/store/settings/ ./internal/daemon/ ./internal/command/ ./internal/api/`
  pass; `TestOnceClearTerminalNewNone` is a table of load, reload, save and restart steps
  (cleared, spellings, a restart before a save, unbinding or rebinding after the clear,
  hand edits, an existing marker), and `TestOnceClearKeepsTheRestOfTheFile` checks the save
  keeps the user's other values and unknown tables.
- End to end on a scratch `daemon --dev` (isolated CODE_FOUNDRY_HOME under /tmp) with
  `"terminal.new" = "none"` in its file: `settings get` says cmd+t, the command List RPC
  gives terminal.new cmd+t, and no marker exists yet. `settings set appearance.font_size 14`
  wrote the file without terminal.new and created the marker. `settings set
  keybindings.terminal.new none` and a daemon restart kept "none". Then with a dev plugin
  installed (its commands registered), the schema RPC gave terminal.new's default as
  cmd+t, and `settings reset keybindings.terminal.new` gave cmd+t in the snapshot, the
  registry and the file.
- The page's look does not change, so no screenshots.
