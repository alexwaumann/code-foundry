# Settings persistence fixes (fuzz pass, config findings 1, 3-7)

Fixes from the 2026-10-21 configuration fuzz pass. Finding 2 (auto-start hiding why
the daemon died) and 8 (a failed download deleting a staged one) are handled
elsewhere.

## Values the app cannot use survive a save (finding 1)

`Store.Update` wrote `render(r.accepted)`, so any hand-written value that failed
validation (an unknown model id, `font_size = 30000`, a `claude_path` that does not
exist yet) or any unknown key vanished on the next save from the CLI, the GUI or a
backdrop import. Now `resolved.fileValues` keeps the accepted values plus the raw text
of every key with an issue. `render` writes each of those keys as it was, under a
`# Ignored: <why>` line: static fields stay in place, unknown keys follow their table's
fields, unknown tables come last, and keys outside any table come first. The raw
values are strings, so `encodeLiteral` writes an int or bool bare only when it reads
back as the same string (`"007"` stays quoted). Resetting or fixing the key removes the
kept value.

Gotchas:
- Comments the user adds are still lost. Keeping them needs a TOML editor that
  round-trips, which we skipped.
- A sub-table under a known table (`[threads.sub]`) decodes as a string such as
  `"map[x:1]"` and is written back as that string. The value is kept but its shape
  changes. This is rare, and it was deleted before this change.
- A top-level key named like a table the file has (`threads = 5`) cannot coexist
  with `[threads]`. It is dropped and logged.
- Removed settings (`threads.render`) are now kept as unknown keys. Retired keys
  (`retiredKeys`) are still dropped on purpose.

The CLI reports these values through a new `Result.Warnings` field
(`InvokeCommandResponse.warnings`). The CLI prints each warning to stderr as a
`warning:` line, so stdout stays the value and `$(code-foundry settings get k)` still
works. `settings set` and `settings reset` list the ignored keys that the save kept.
`settings get <key>` warns about that key's own issue, and `settings get` lists all of
them. The palette ignores warnings.

## Plugin command keybindings (finding 3)

`SetCommands` ran once, before plugins started. The plugin store now gets the registry
wrapped in `settingsCommandHost` (internal/daemon/settings_commands.go). Its
`ReplacePrefix` re-runs `SetCommands` after every plugin register or unregister. The
wrapper lives in the daemon rather than the plugin store, so the plugin store needs no
settings dependency. Lock order: the plugin store's opMu, then settings.mu, then the
hooks (registry and plugin `m.mu`). No hook takes opMu. `SetCommands` now logs only
keybinding issues that are new, so plugin churn does not repeat warnings. While a
plugin is disabled, its overrides stay in the file as "unknown command" issues.
`settings get` of that key fails as an unknown setting until the plugin is back.

## Updater and the global link (finding 4)

`runUpdate` passes `--skip-link --skip-path` unless it installs into the default home's
app directory (`installerShellArgs`). `install.sh`'s `link_cli` no longer replaces a
link or file that leads to another existing install. It replaces one only with
`--force` or when the user agrees at an interactive prompt. Otherwise it warns and
installs anyway. A missing or dangling link is still created, and a link that already
reaches this install (`-ef`) is re-pointed silently. When the version is already
installed, the installer can create a missing link but never re-points one
(`link_cli keep`).

## Unparsable file at start (finding 5)

Every successful load and save writes `settings.toml.lastgood` beside the file (only
when the bytes changed). If the file does not parse at `Open`, the store uses the
values from that copy, else the defaults, and `LoadError` is still set, so saving stays
paused. The GUI banner and the proto comment now say "the last settings that loaded
stay in effect (the defaults if none have)". The copy sits next to the configured path
even when settings.toml is a symlink.

## Symlinked settings.toml (finding 6)

`writeAtomic` follows the link chain (`resolveLink`, which handles dangling links and
gives up on loops). It writes the temp file in the target's directory and renames it
over the target. An existing file keeps its permission bits; a new one gets 0600. The
watcher also watches the target's directory and matches events by full path (the
target may have another name). The target is resolved once, at Open.

## DB path escaping (finding 7)

`dsn` builds the SQLite URI with `url.URL`. `#`, `?`, `%`, spaces and the like are
escaped, so the database lands where it should and opens. The test opens a database
under each of those names and checks that the pragmas still apply.

## Verified

Unit and table tests cover each fix. End to end with a scratch daemon
(CODE_FOUNDRY_HOME=/tmp/...):
- Hand-edited invalid values survived `settings set`, with a one-line warning.
- The minimal example plugin's keybinding could be set, was kept while the plugin
  was disabled, and applied again when it was re-enabled.
- After a duplicate `[advanced]` table and a daemon restart, the last-good values
  applied and `settings get` warned.
- A symlinked settings.toml stayed a link through saves, and edits to its target
  were picked up.
- `code-foundry update` ran against a local release dir with a scratch `HOME` and
  `CODE_FOUNDRY_HOME`. It made no link and no .zshrc change. With the default home,
  an existing link to another install was kept, with a warning.
