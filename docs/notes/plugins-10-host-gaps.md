# Plugins 10: host gaps (close reasons, command errors, CLI ergonomics, limits)

The host-side gaps chosen for release from `docs/notes/plugins-integration.md` ("Known
gaps"), plus one found while fixing test-watcher (item 10). Stacked on
`cf/plugins-7-registry`; no GUI change beyond regenerated protobuf types.

## What changed, item by item

1. **`surface/close` reasons.** An open instance closes at once with `context_gone` when
   its thread is archived or removed or its project removed, and with `unavailable` when
   its `when` clause turns (definitely) false; `idle` stays for the grace, now 10 minutes
   (`DefaultSurfaceGrace`) so a plugin's per-instance state survives a tab switch. The
   daemon calls `plugin.Manager.ContextsChanged` on thread and project events
   (`internal/daemon/plugin_contexts.go`); the store's own `AvailabilityChanged` (checks
   arrived, `context/set`) triggers the same `recheck` (`surface_close.go`, batched 250 ms).
   A watched instance closed as unavailable shows "closed: …" and reopens when the clause
   holds again; one closed as context_gone is dropped unless watched. A thread scoped
   surface is no longer available on an archived thread (`ThreadFacts.Archived`). SDK:
   **`Surface.Close(reason CloseReason)`** (breaking: it took no argument and no struct, so
   the signature changed; `CloseIdle`, `CloseContextGone`, `CloseUnavailable`, plus the
   SDK's own `CloseShutdown` and `CloseReopened`); plugintest `CloseSurfaceFor`. The skill
   says to keep state that must outlive a close in the plugin.
2. **Plugin command errors.** `command.Failed` marks a command's own failure; the API maps it
   to `InvalidArgument` (a plugin's `CodeInvalidParams`) or `FailedPrecondition` with a new
   `CommandFailed` error detail, and the CLI prints `code-foundry <cmd>: <message>` and exits
   1 (no "(unknown)", no help pointer). A command of a plugin that is not running fails the
   same way: "plugin X is crashed (…); it retries in 1s, or run `code-foundry plugin restart
   X`" (`commandDownLocked`; disabled says `plugin enable`). Registry argument errors stay
   usage errors (exit 2). Table tests in `internal/api/command_test.go`,
   `cmd/code-foundry/registry_test.go`, `internal/store/plugin/internal_test.go`.
3. **CLI ergonomics.** `plugin list` shows `unknown` for a surface whose clause waits on a
   fact (`PluginSurface.unknown`; commands have no per-command column, so only surfaces).
   `plugin surface --settle 2s` waits until no new view for that long (`GetSurfaceRequest
   .settle_ms`, capped at 30 s, the whole settle too). `plugin act` prints the view after
   a 500 ms settle (`--settle`, `--quiet`), and presses command buttons: the element's
   command runs through the registry with the panel's context and the element's args
   (`SurfaceElement.args`, also printed by `plugin surface`), a form's `--values` merged in
   as args, the command's own confirmation passed on (`plugin act` lists as confirming so
   the CLI offers `--yes`; `command.ConfirmedIn(ctx)`). `--json` of `plugin act` is now
   `{version | command, message, result, surface}`. Skill `testing.md`, `SKILL.md`,
   `primitives.md` say so; the generated CLI reference follows the descriptions.
4. **`secret/changed`.** Deleting a secret from the CLI or Settings sends the running plugin
   `{key, deleted: true}` (`Plugin.OnSecretChanged`; plugintest `DeleteSecret`). Under
   `uninstall --purge` the plugin is already stopped, so the call is a no-op there. Consent
   never changes under a running plugin (growth disables it, re-consent starts it with the
   new grant: `TestPermissionGrowthDisables`); host-api.md says both.
5. **Limits.** A command action's args: 16, 4 KiB of names and values, 2 KiB a value
   (`ui.MaxCommandArgs…`, enforced by `ui.View.Validate`, so the host and the SDK agree); an
   act's values 64 KiB encoded (`ui.MaxActValues`, checked in `Manager.Act`). The skill's
   generated limits table has both rows.
6. **Noise.** A successful `host/invoke` is a debug line in the plugin's log and the daemon
   log; a failure stays at info. An unchanged `thread/setFlag` is a debug line.
7. **Dead code.** `laterMethods` is gone; the nil-dependency guards are `notServed` ("not
   available in this Code Foundry").
8. **Direct installs get updates.** A plugin installed from `owner/repo` that no registry
   lists (or lists from another repository) gets its repository's newer release as an
   offer: `CheckUpdates` asks `gh release view -R owner/repo --json tagName` once per
   such plugin per check (the daily cycle), `UpdateOffer.Ref` installs `owner/repo@vX`.
   Test with the fake gh in `TestInstallFromGitHubRelease`.
9. **pluginsdk polish.** `Field.WithValue/WithPlaceholder/WithHint/AsRequired/WithPattern/
   WithStore/WithChange` (copies, never aliasing the original's input) and
   `Host.SetContextString/Bool/Int/Strings`, `ClearContext` with `ForThread`/`ForProject`;
   `SetContext` stays.
10. **Plugin terminals are readable.** `terminal/read {terminalId, maxBytes}` → `{text,
    truncated}`: the screen as plain text (the terminal store's `ScreenText`: rows, no
    scrollback, no escapes), its end from a line start when over `maxBytes` (64 KiB
    default, 256 KiB max). `terminal/exited {terminalId, exitCode}` once per terminal from
    the terminal store's events (`internal/daemon/plugin_terminal_exits.go`); no separate
    `signal` field (the store reports 128+n). SDK `Host.ReadTerminal`,
    `Plugin.OnTerminalExit`; plugintest `SetTerminalText`, `ExitTerminal` now notifies.
    Help text: `plugin terminals` no longer names `terminal read/write` verbs that do not
    exist, `plugin install` lists every checksums file name it accepts.

## Checked end to end

Isolated home (`~/.cf-p10-e2e`), dev daemon from this branch, `hello` linked with `plugin
dev`: `plugin surface hello demo --settle 1s` (1.1 s, elements with `name=panel`), `plugin
act --key greet` ("ran plugin.hello.greet …: Hello, panel!" then the view), `--key forget`
without a terminal ("Re-run with --yes"), `pin` then `plugin hello unpin` → "closed
hello/pinned/… (unavailable: its condition does not hold here: hello.pinned)", `thread
archive` → "closed hello/demo/… (context_gone: the thread was archived)" and `plugin surface`
refusing the archived thread, `plugin hello send --context-thread=` → the plugin's message,
exit 1, `kill -9` of the plugin then a command → "plugin hello is crashed (was killed by a
signal); it retries in 1s, or run …", exit 1, and the Shell tab's clock terminal killed →
"terminal t-… exited (137)" in the plugin's log.

## Decisions and gotchas

* `make gen`'s remote buf plugins were rate limited and then unavailable; the code was
  generated with the same versions as local plugins (`protoc-gen-go v1.36.12`,
  `protoc-gen-connect-go v1.21.0`, `protoc-gen-es 2.16.0`), byte-identical for untouched
  files.
* `Surface.Close(reason)` breaks the two plugin repositories at their next SDK bump (one
  line each); the stack is untagged, so it changes before `pluginsdk/v0.1.0`.
* A `pr` instance has no thread of its own: `recheck` evaluates its clause in the context
  it was last opened or acted in, and says nothing when that thread is gone.
* `plugin act` resolves a command element in the current view only; acting on an older
  `--version` goes to `Act` as before.
* `terminal/read` is the screen, not the scrollback: reading the scrollback needs a new
  terminal store method on the emulator's goroutine; host-api.md suggests `tee` to a file
  for whole-run output.

## Not fixed (noted for later)

Watching `plugins/` and dev folders, a running thread picking up a new session environment,
bottom-panel shells getting it, Keychain and `~/.claude.json` writes from isolated homes,
usage grouped by plugin, signing, byte progress for gh downloads; `plugin list` per-command
availability (only surfaces show `unknown`); a scrollback read for plugin terminals.
