# Notifications: plugin health

When a plugin stops for good, or the daemon turns it off, the bell gets a card, and the card is
withdrawn as soon as that no longer holds. Agreed with a user on 2026-11-17: "Plugin crashed or
disabled itself: withdrawn when it runs again", normal (not time-sensitive). The user's main
requirement: a card never outlives its reason. Built on the store (`notifications-1-store.md`)
and the plugin sink (`notifications-2-plugins.md`).

## What landed

- `internal/daemon/plugin_health.go`: the glue. `pluginHealth` (pure: one plugin's state to
  clear, keep or post), `healthPlan` (pure: every plugin plus this source's keys to the posts and
  the keys to retire), `reconcilePluginHealth` (applies a plan), `startPluginHealth` (a pass at
  start, then one per burst of plugin state events). Started in `daemon.go` after
  `plugins.Start`, so the first pass sees every plugin.
- Source `plugins` (`notification.SourcePlugins`), one card per plugin, key = the plugin's name.
  It is in `hostSources`: no plugin may post under that name, the start sweep never takes these
  cards for a removed plugin's, and a plugin's `release` (disable, uninstall) withdraws only its
  own source's notifications, never these.
- Store: `Retire(source, key)` and `Keys(source)` (`internal/store/notification/retire.go`).
- Actions: `notificationActionCalls[KindCommand]` runs the verb a `plugins` card names itself
  (`verbSources`), where a plugin's card runs `plugin.<source>.<command>`.
- GUI: `sourceLabel` names the source "Plugins". The mock has
  `/__mock/notifications/plugin-health?name=&display=&state=failed|off|running`.

## The rules

| Plugin | Card |
| --- | --- |
| running | withdrawn |
| off with a `DisabledReason` (the daemon's: its permissions grew) | warning "<Name> was turned off", the reason, Open plugins |
| off without one (the user disabled it, or never enabled) | withdrawn |
| enabled and failed (bad manifest, unsupported protocol, missing executable, needs a newer Code Foundry, crashed 5 times in 10 minutes) | error "<Name> stopped", the reason, Restart and Open plugins |
| starting, crashed (a retry is due), stopping, stopped, enabled but not started yet, failed with no reason | kept as it is |
| gone from the store | withdrawn |

- The body is the plugin store's own reason (`LastError`, `DisabledReason`), first letter upper
  case, control characters dropped, cut to the store's caps (title 120, body 1000) with "…".
- A changed reason is an update in place (no new toast).
- **Crashed never posts** (the flapping rule). The store retries a crash after 1, 2, 4, 8 s
  (`backoff`), and a non-dev plugin that crashes 5 times in 10 minutes is failed: that is the
  "for good" signal, about 15 s after the first crash of a plugin that dies at start. Posting at
  the first crashes would toast and withdraw a card within seconds. A plugin that crashes every
  few minutes runs most of the time; a card would come and go with each crash, so it gets none
  (the plugins page shows its restart count). A dev plugin never gives up restarting (2 s at
  most): its author is watching its log, so no card for it either, except a bad manifest, which
  fails a dev plugin too.
- **Transitional states keep the card.** After Restart the plugin starts; if it fails again with
  the same reason, the post is unchanged (no second toast, the card stays where it was); if it
  runs, the card is withdrawn. Withdrawing at "starting" would instead toast the same failure
  again on every unsuccessful restart.
- **Neither button resolves the card.** Restart that fails again must leave it: a resolved card
  re-posted with the same content stays resolved (store rule), so the failure would vanish from
  the bell while it still holds. Whether the plugin runs decides.
- **Retire, not Withdraw, when the reason clears.** Withdraw leaves a dismissed or resolved
  notification as it is, and the store keeps a dismissed one dismissed for the same content. So a
  dismissed "Hello stopped" would never show again for the same failure, even after the plugin ran
  in between. `Retire` marks it withdrawn whatever its state: the next failure is a new arrival.
  A dismissed card whose plugin is still failed stays dismissed (the reason did not clear).
- **The start pass reconciles**: it posts what holds and retires every other key of the source,
  so a card from the last run for a plugin that runs now, or that was removed while the daemon was
  stopped, goes.

## Actions

- Restart: `plugin.restart --name <plugin>` (re-reads the manifest, also from failed).
- Open plugins: `view.settings --page plugins`, the plugins list with the plugin's state, log and
  Enable.
- The daemon-disabled card has no Enable button. `plugin.enable` asks for consent bound to the
  text shown (`BindConfirm`), and the GUI applies a confirmation's bind only to the command it
  invoked (`notification.act`, not `plugin.enable`), so through a card the consent would not be
  bound to what the user read. The plugins page's Enable does bind it.
- `notification.act` runs a `plugins` card's command action as the verb it names
  (`verbSources` in `commands_notification_act.go`). Only the daemon posts as `plugins`: a plugin
  by that name is refused (`postOf`), and `notification.post` posts as `command`, which may not
  carry command actions at all. The store still checks the name's shape (`commandPattern`).

## Gotchas

- Restart after a bad manifest is fixed publishes the re-read manifest while the state is still
  failed and the reason empty (the manifest's error is gone, the actor's never set), then
  starting. Found end to end: the card was updated to an empty body for a moment. Failed with no
  reason now keeps the card.
- `DisabledReason` lives in the plugin store's memory. After a daemon restart a plugin the daemon
  turned off reads as plain disabled (its row says not enabled), so the start pass withdraws its
  warning card, as the plugins page loses the reason too.
- The glue reacts to `Changed`, `Removed` and a resync only; facts, install progress and registry
  offers are frequent and never change a plugin's state. Each pass reads the whole snapshot, so a
  dropped event costs nothing.
- A plugin's own `release` withdraws `WithdrawSource(<plugin name>)`; the daemon's card is source
  `plugins` and survives exactly as long as its condition. `hostSources` must list every host
  source, or the start sweep would withdraw it as a removed plugin's.
- The daemon test uses `plugintest.Fake` for exact states (`Remove` added) and the real
  notification store; `startPluginHealth` takes a `passed` hook the test waits on, so no sleeps.

## Tests

- `plugin_health_test.go`: `TestPluginHealth` (every state, including the crash and dev
  crash-loop rules, the levels, titles, bodies and actions, each card accepted by the store's
  `Check`), `TestPluginHealthBounds` (long and odd names and reasons), `TestHealthPlan`,
  `TestPluginHealthGlue` (start reconcile, update in place, no new arrival across a failed
  restart, release and a plugin named `plugins`, running withdraws, dismissed then recovered then
  failed again arrives again, user disable, daemon disable, removal).
- `retire_test.go`: Retire in every state, Keys, the same content arriving again after Retire.
- `TestNotificationAct`: a `plugins` card's command runs the verb; a plugin's never does.
- vitest: `sourceLabel` for `plugins`.
