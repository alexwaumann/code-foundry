# Plugin flag retirement: thread/setFlag becomes a notification, and the SDK's removal list

The sixth of six steps of the notifications build (2026-11-16). Built on the store
(`notifications-1-store.md`) and the plugin calls (`notifications-2-plugins.md`). Daemon,
SDK and skill only: the GUI's old flag display goes with step 4 (the row mark). Until then
it simply has nothing to show, since `Thread.flags` is always empty.

## What landed

- **Reroute** (`internal/daemon/plugin_flags.go`): `thread/setFlag` keeps its request,
  result and `threadStatus` permission, and the daemon posts a notification under the
  plugin's source with the key `flag:<thread>` (`flag:<thread>:until-seen` for an
  until-seen flag; `notification.FlagKey`/`ParseFlagKey`). The plugin store
  (`internal/store/plugin/flags.go`) still checks the permission, the level, the reason and
  the rate (one a second per thread), and logs.
- **Removal list** (`pluginsdk/removals.go`): `Removal{Symbols, Method, Replacement, Hint,
  Stage, Deprecated, Retired}`, `RemovalOf`, `RemovalOfMethod`, `Notice`, and `Retired(log,
  symbol)` for retired stubs. First entry: `Host.SetFlag` / `thread/setFlag` with `Flag`,
  `FlagResult`, the level constants, `MethodThreadSetFlag`, `Host.Flags`,
  `InitializeParams.Flags`, `plugintest.Options.Flags` and `plugintest.Host.Flags`,
  deprecated 2026-11-16. Each carries a `Deprecated:` comment naming `Host.Notify`.
- **Host side of the list** (`internal/store/plugin/removals.go`): a deprecated method is
  served and its notice goes to the plugin's log once per run (level `warn`); a retired one
  is answered `{}` without running its handler (so not even its permission is checked) and
  logged once per run; a retired notification method is dropped the same way.
- **`plugin removals`** (`commands_plugin_removals.go`, `--json`): the list as this daemon's
  SDK has it. `removals` joined the reserved plugin names.
- **Skill**: SKILL.md's "Before changing a plugin" section; `reference/removals.md`, its
  table rendered from `pluginsdk.Removals` (`{{cf.removals}}`), so it cannot drift; flag
  guidance moved to `host-api.md`'s Notify ("About a thread"), SetFlag reduced to a short
  deprecated section; `primitives.md`, `wakes.md`, `manifest.md`, `protocol.md`,
  `testing.md` updated.
- **plugintest** (`plugintest/flags.go`): `SetFlag` shows as a notification with the same
  key, level and title rules; `FlagNone` withdraws; `SeeThread(id)` dismisses until-seen
  ones; `Options.Flags` seed active notifications; a plugin's own `flag:` key is refused.
- **Examples**: hello's `flag` command is now `mark` (a notification keyed `mark:<thread>`,
  `--level none` withdraws), its manifest drops `threadStatus`; minimal's README consent
  example names `notifications`.

## Decisions

- **Mapping**: attention → warning, error → error, never time-sensitive, no body, no
  actions, the thread named. The reason is the title. The old 80-character, one-line cap
  stays (it always fits the 120-character title, so nothing is split); an empty reason,
  refused before, is now accepted and titled "<display name> flagged this thread".
- **Until-seen lives in the key**, since nothing on a notification can hold it and there
  is no schema change. One flag per plugin and thread still holds: setting one mode
  withdraws the other mode's key.
- **Seen = dismissed.** The thread store's seen moments (a viewer opening while presence is
  attended, presence rising with the thread open) now call a hook (`SetSeenHook`), which
  dismisses every plugin's `flag:<thread>:until-seen` notification. An until-seen flag set
  while `Seen(thread)` is true is never posted (`changed: false`, as before when nothing
  was stored). Consequence, on purpose: the same until-seen reason raised again after the
  user saw it stays dismissed (the key rule), where the old flag came back. A plugin that
  reports a new occurrence changes the reason; the skill says so.
- **Archive withdraws flag notifications** (kept from the old behaviour), on the thread's
  `Updated` event and in a sweep at start and every minute; setting a flag on an archived
  thread is still refused (-32002). Notifications that are not flags stay on archive, as
  step 1 decided. Removing the thread withdraws them (step 1), disabling or removing the
  plugin withdraws them with its other notifications (step 2): the old `ClearPlugin` and
  `Plugins` of `plugin.ThreadFlags` are gone.
- **`Changed`** is true when a post changed something (not `unchanged`) or the other mode's
  key was withdrawn; for `none`, when an active one was withdrawn. Re-asserting a flag the
  user dismissed answers `changed: false`.
- **`Host.Flags()` / `InitializeParams.Flags`** are read from the plugin's active flag
  notifications (snoozed ones count): level back to attention/error, the title as the
  reason, `SetAt` the notification's last change. A dismissed or withdrawn one is not in
  the list, as a user's clear removed it before.
- **Old manifests**: only `threadStatus` is needed; the flag path never checks
  `notifications`. A plugin's own `notification/post` (and a wake fire's notification) with
  a key starting `flag:` is refused -32602.
- **Stored flags** are converted at daemon start (`convertLegacyFlags`, in `stores.go`
  after the notification store opens, before plugins start, so `initialize` reports them)
  through the same `SetFlag`. Each row is deleted once converted, or when it can never
  convert (its thread gone or archived); a row whose post failed otherwise stays for the
  next start. The table `thread_flags` (migration 0030) and its columns stay, now unused:
  nothing reads or writes it after the conversion. Idempotent by key (a crash between the
  post and the delete re-posts the same content: unchanged).
- **Retired stage now, built and tested**: `Retired` warns once per process per symbol;
  the host's answer to a retired method is `{}`. Tested with test-only entries.
- **The list-vs-code test** (`pluginsdk/removals_test.go`) parses every non-test Go file in
  the SDK module: every `Deprecated:` symbol is listed, every listed symbol exists and is
  marked, dates are YYYY-MM-DD, a retired entry has its date.
- **CLI verb over `--json` on a neighbour**: no existing plugin verb fits a list that is
  not about installed plugins.

## Every daemon-side reader of thread flags, settled

| Reader | Now |
|---|---|
| `Thread.flags` (proto, `api/thread_lifecycle.go`) | not filled; field 54 kept, documented as always empty |
| Thread store `Thread.Flags`, `SetFlag`, `ClearFlags`, `ClearFlagSource`, `FlagsOf`, `loadFlags` | removed; the store keeps the seen hook, `Seen` and the legacy reader |
| Archive dropping flags (`archive.go`) | removed; the daemon withdraws flag notifications on archive |
| Seen clearing until-seen flags (`attended.go`) | the seen hook |
| Status, ordering, attention counts, dock, Needs you | never daemon-side (the GUI derived them from `Thread.flags`); with it empty, a flag no longer moves a thread |
| Wake text, `thread list` | never read flags |
| `thread get` (flags line) | removed; `thread flags` and `notification list` show them |
| `thread flags <id>` | lists the thread's flag notifications (with notification id and status) |
| `thread flag clear` / `ThreadService.ClearFlags` | dismisses the thread's flag notifications (one plugin's with `--plugin`) |
| Plugin store start sweep (`Flags.Plugins`) | gone; the notifications sweep covers flags |
| `release` (`clearFlags`) | gone; `withdrawNotifications` covers flags |

## Tests

Go: `internal/daemon/plugin_flags_test.go` (each reroute rule as a table, `Of` and
dismissal, the seen hook and archive glue, the conversion and its second run, the prefix
on both sides), `internal/store/plugin/removals_internal_test.go` (deprecated / retired
methods and notifications, once per run), `notify_test.go` (`flag:` key refused),
`hooks_test.go` (a manifest with `threadStatus` and no `notifications` sets flags; the
deprecation notice once per run), thread store `flags_test.go` / `attended_test.go`
(the seen hook at the old moments, legacy rows), `api/plugin_hooks_test.go`,
`command/commands_thread_flags_test.go`, `commands_plugin_removals_test.go`,
`skills/removals_test.go`, `pluginsdk/removals_test.go` (list vs code, `Retired`),
`plugintest/flags_test.go`.

## End to end (2026-11-16)

A scratch home under /tmp. The daemon and the hello plugin as they were before this
change (built from `origin/main`) set two flags (sticky attention on one thread,
until-seen error on another) into `thread_flags`; that daemon stopped, this branch's
started on the same home with `make drive DAEMON=dev`:

- daemon log: `flags from before notifications converted count=2`; the old plugin's Init
  logged `flags=2`; `thread_flags` had 0 rows; `notification list` showed both, warning
  and error; `thread get` no longer prints flags.
- The old hello on the new daemon: `flag --level attention` posted `flag:<t>` (warning);
  `--level error` updated it in place to error; `--until-seen` on another thread posted
  `flag:<u>:until-seen`; `--level none` withdrew `flag:<t>`; `thread flag clear` on the
  converted one dismissed it and `thread flags` then said none.
- The GUI open in headless WebKit (presence attended): `thread focus --id <u>` dismissed
  the until-seen one; a new until-seen flag on the open thread was never posted.
- Plugin log: one `warn Host.SetFlag (thread/setFlag) is deprecated since 2026-11-16 …
  use Host.Notify (…)` for the run.
- Restart: everything kept, no second conversion, Init logged `flags=1` (the dismissed
  ones left the list). Archiving the converted until-seen thread withdrew its flag; a
  new flag there was refused (archived).

The scratch home, the old build and the linked plugin folder were removed; no Claude
process was started (no thread had a prompt).

## Gotchas

- `staticcheck` reports every use of a deprecated SDK symbol (SA1019), including the
  host's own: the files that serve or test the flag carry `//lint:file-ignore SA1019`
  with the reason. A new deprecation needs the same in its server.
- `plugin dev` refuses a folder outside the home directory, so the pre-change plugin was
  copied under the home for the end to end.
- The seen hook runs under the thread store's lock: it must not call back into the thread
  store (the notification store never does).
