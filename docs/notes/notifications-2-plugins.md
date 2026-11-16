# Notifications 2: plugins post, withdraw and attach notifications to wake fires

The second of six steps of the notifications build. Built on PR 1's store
(`notifications-1-store.md`). No GUI: the bell is step 3.

## What landed

- **Protocol + SDK** (`pluginsdk/notify.go`): `notification/post` (`Notification` →
  `NotifyResult {id, key, outcome, status}`) and `notification/withdraw` (`{key}` →
  `{withdrawn}`); `Host.Notify`, `Host.WithdrawNotification` (returns whether an active one
  went), `Host.FireWakeNotify`; `WakeFire.Notification` and `WakeFireResult.Notification`.
  Action builders `CommandAction`, `SendAction`, `StartAction`, `OpenAction`. Capability
  `notifications` (`NotificationsCapability`). Outcomes: `posted`, `scheduled`, `updated`,
  `unchanged`, and `routed` for a fire's notification a thread took.
- **Permission** `notifications` (manifest, `Within`, `Describe`, `jsonFieldNames`, proto
  `PluginPermissions.notifications = 9`, `plugin list`). The registry entry script writes the
  key only when set (`omitempty`), so a registry whose schema predates it takes every other
  entry unchanged; a plugin asking for it needs the registry's schema to know the key first.
- **Host** (`internal/store/plugin/notify.go`, `wakes.go`): the two methods in `hostMethods`
  gated by the permission; `Options.Notifications` (a `NotificationSink`); `release` withdraws
  a disabled or removed plugin's notifications, and the start sweep those of plugins not
  enabled. The daemon adapts the notification store (`internal/daemon/plugin_notifications.go`).
- **Act**: `notificationActionCalls[KindCommand]` runs `plugin.<source>.<command>` with the
  stored args through the registry, like the palette.
- **Store** additions: `Check` (Post's checks without posting), `WithdrawSource`, `Sources`,
  `Active(source, key)`.
- **plugintest** (`notify.go`): the key rules, the permission, `Options.Commands` refusing an
  undeclared command action, fire routing; `Notifications`, `Notification(key)`,
  `ActiveNotifications`, `NotificationWithdrawals`, `DismissNotification`, `PressAction`,
  `PressedActions`.
- **Example**: hello's `notify` (a failed-build notification on a thread with Open run and
  Docs; `--withdraw`), `open-run`, and a notification on every `tick` fire (`fire-tick
  --time-sensitive`). Skill: `host-api.md` "Notify", `wakes.md` "Report an event once",
  rows in `protocol.md`, `manifest.md`, `testing.md`, and "notifications" in SKILL.md's
  host-api row.

## Decisions

- **Source isolation** is the adapter's: source is always the calling plugin's name, so a
  plugin never names another's keys. A plugin named `command` (the CLI's source) is refused;
  `hostSources` keeps the app's own sources out of `Sources` and `WithdrawAll`, so the start
  sweep never takes `command`'s notifications for a removed plugin's. A future host source
  must be added there.
- **Naming a thread needs no thread permission.** `thread/setFlag` needs only `threadStatus`
  to mark any thread, no `threads`; the notification permission is the match. The thread must
  exist (the store checks). A send action's thread too. The consent line says the buttons can
  send to a thread and start one, since the user presses buttons whose text they do not see.
- **Command actions** must name one of the plugin's own manifest commands, with arg names that
  command declares (checked at post time against the running manifest). A show command
  (`plugin.<name>.show.*`) is not a manifest command, so a button cannot open a panel
  directly: it runs the plugin's command, which opens it (below). An update that drops a
  command leaves older buttons failing NotFound when pressed.
- **The act** runs with the caller's view and origin but no thread or project, so a plugin
  command with a `when` clause about the active thread is unavailable from a button: the
  args must say what the command is about. A command's `confirm` asks first
  (ConfirmationRequired, then `confirmed`), as for any act.
- **"Open my panel on this item" works with what exists**: the button runs the plugin's own
  command (`open-run --run --thread`), which records the pick for that thread (applied at
  once to an open instance, else taken by the next one the factory opens) and calls
  `host/invoke plugin.hello.show.demo` with `focus: true` and the thread as context. The only
  cost is listing the show command in `permissions.commands`. Nothing was added to the host.
- **Routing** (`wake/fire` with a notification): permission and the notification are checked
  before the wake goes, so a refusal fires nothing. Then the fire as before; a normal
  notification is posted only when `delivered == 0`; a time-sensitive one always. A routed one
  writes nothing (an earlier post of the same key stays as it was).
- **"Delivered"** is the thread store's count of wakes queued (`fireLaterLocked`): a stopped
  subscriber counts (the wake starts it), a snoozed one counts (it is unsnoozed), one over its
  wake limit does not, an archived one has no subscriptions left (archive ends them).
  `TestPluginWakeDelivered` pins this.
- **Rate**: 10 posts a second per plugin (unchanged re-posts count; withdraw never limited);
  a fire's notification counts against the fire rate only. 100 active per plugin (the
  store's cap) is CodeUnavailable.
- **Withdraw** of a key with nothing active is `{withdrawn: false}`, not an error, so a
  plugin can withdraw on every "condition cleared" without bookkeeping.
- **`FireWakeNotify` refuses on a host without the capability** (`ErrNoNotifications`): an
  older host would ignore the field, deliver the wake and drop the notification silently.
- `thread/setFlag` is untouched (step 6).

## Tests

Go: plugin store (`notify_test.go`, helper mode `notes` with a fake sink): permission
refusal, source isolation, undeclared command or arg, sink refusals mapped to codes, the four
routing branches, a refused fire firing nothing, restart keeps / disable and uninstall
withdraw / start sweep. Daemon (`plugin_notifications_test.go`): the adapter on the real
store, error mapping, `command` excluded. Store (`source_test.go`). Thread store
(`TestPluginWakeDelivered`). Command (`TestNotificationAct`: the command kind, its confirm,
confirmed). SDK: `TestPermissionsWithin`, plugintest's `notify_test.go`. Example:
`notify_test.go` (Open run end to end through plugintest, tick routing).

## End to end (2026-11-16, `make drive DAEMON=dev`, scratch home under /tmp)

`plugin dev plugins/examples/hello --yes`; `plugin list` shows `notifications` and
`plugin.hello.show.demo`. A thread without a project (Sonnet 5.5 medium).

- `plugin hello notify --thread <t>`: `build-5 posted (shown)`, again `unchanged (shown)`;
  `notification list` shows it with `1 Open run, 2 Docs`.
- `notification act <id>`: `ran "Open run" …, which is resolved: Build #5 on <t>: the demo
  opens on it (opened Hello Demo for thread <t> as tab …)`; `layout show` has the demo tab of
  the thread, focused; `plugin surface hello demo` shows tab `run-list`, `selected
  runs-run-5`, the run's facts.
- `fire-tick --every 1h` with no subscriber: `woke 0; notification tick-1h posted`.
  Subscribed (`--repeat`): `woke 1; a thread got it, so no notification`, the list unchanged,
  the thread got the wake. `--time-sensitive`: `woke 1; notification tick-1h updated` (now
  time-sensitive); a fresh key time-sensitive and subscribed: `woke 1; … tick-2h posted`.
- Subscriber archived (`--yes`): its subscriptions gone; `fire-tick --every 3h`: `woke 0;
  notification tick-3h posted`.
- `plugin restart hello` keeps them; `plugin disable hello`: `notification list` empty, `--all`
  shows them withdrawn, plugin log `withdrew its notifications: 3`.
- `notify --thread s-000000000000`: `notification/post: not found: there is no thread …`.

The daemon was stopped with the drive task, the scratch home and the test thread's transcript
removed.

## Gotchas

- `make drive DAEMON=dev` with a home in the session scratchpad fails: the socket path is over
  macOS's 103 bytes. Use a short `DRIVE_HOME` under /tmp.
- `json` is a reserved arg name (a CLI flag); the helper plugin's arg is `note`.
- Archiving a thread a wake just started asks first (Claude is working): `--yes`.
