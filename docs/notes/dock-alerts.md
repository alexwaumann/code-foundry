# Dock badge and attention alerts, PR 1: badge, bounce, settings

Decided 2026-10-14 (Alex). PR 1 of 2: the Dock badge, the Dock bounce and every
`notifications.*` setting. PR 2 adds the alert sound (`notifications.sound`,
`notifications.sound_volume`), which fires on the same trigger.

## Why no notification banners

The GUI ships as a bare executable with an embedded `__TEXT,__info_plist` and no `.app`
bundle (`bare-binary-distribution.md`). `UNUserNotificationCenter` needs a bundle proxy and
throws `bundleProxyForCurrentProcess is nil` for such a process. Wails'
`pkg/services/notifications` must never be wired in: its bundle-id check passes because
of the embedded plist, and the first call then crashes the GUI. What works without a
bundle: the Dock tile's badge (`[[NSApp dockTile] setBadgeLabel:]`) and
`[NSApp requestUserAttention:NSInformationalRequest]` (one bounce; AppKit ignores it
while the app is active and stops it on activation).

## Settings (group "Notifications", after Appearance, all live)

| key | type | default |
|---|---|---|
| `notifications.dock_badge` | bool | true |
| `notifications.bounce` | bool | true |
| `notifications.sound` | bool | false (consumer in PR 2) |
| `notifications.sound_volume` | int 0–100 | 50 (percent of the Mac's output volume; PR 2) |
| `notifications.cooldown_seconds` | int 0–3600 | 60 |

Older `settings.toml` files without the table load with these defaults and no issues
(`resolve` falls back to `Field.Default` for every missing key;
`TestOlderFileGetsNotificationDefaults`). The Playwright mock (`mock/settings.ts`)
mirrors the fields.

## Host (`gui/notify.go`, `gui/notify_darwin.go`)

* `AppService.SetBadge(count)`: `badgeLabel` gives "" (no badge) for 0, "99+" above 99.
  `AppService.Bounce()`: one informational request.
* Own cgo rather than Wails' `pkg/services/dock`: that service is a registered service
  whose `SetBadge` does `dispatch_sync` onto the main queue and fails when the activation
  policy is not Regular yet, and it has no bounce. Ours `dispatch_async`es both calls to
  the main queue, so they are safe from the binding goroutines and never wait on AppKit.
  (`WebviewWindow.Flash(true)` does the same bounce; one file for both is simpler.)
* **Badge before launch**: for a bare executable AppKit replaces the Dock tile when
  launching finishes (the reason `icon.go` sets the icon again then), so a badge set
  earlier would be lost. `dockBadge` remembers the last label; before
  `ApplicationDidFinishLaunching` it only records it, and the launch handler applies it
  right after `SetIcon` (both queue onto the main thread in that order). Repeated labels
  are skipped.
* No stubs for other GOOS, like `trafficlights_darwin.go` (macOS only).

## Frontend (`stores/dockAlerts.ts`, started from `App.tsx` `startApp`)

* `stepDockAlerts(state, input) -> { state, effects }` is the whole decision, pure and
  table-tested; `startDockAlerts` feeds it from the sessions and settings stores and runs
  the effects through `api/app.ts` `setDockBadge` / `bounceDock` (no-ops without a Wails
  host, detected with `appInfo()` like `setHostZoom`).
* **Attention set**: `stores/sessions.ts` `attentionIds`, the same count as the bell, the
  window title and cmd+shift+a (unarchived threads with status `attention`: waiting on the
  user or a finished turn). Errors are left out, as there: after a daemon restart every
  busy thread turns "interrupted", and the badge would disagree with the title. An earlier
  draft counted the sidebar's `error` group too; it was narrowed to match before review.
* **Badge**: the set's size when `dock_badge` is on, else 0; sent only when it changes.
  Ignores focus and cooldown. Nothing is sent before the first settings snapshot, so a
  badge the user turned off never flashes on at startup.
* **Trigger**: a thread id in the set that was not in it at the previous evaluation,
  while the app is unfocused.
* **Baseline**: the first evaluation, and the first after the sessions store's new
  `epoch` changes, only records the set. `epoch` is bumped by the List on every
  events-stream (re)connect (`reconcileSessions`) and by every session snapshot event, so
  startup, a reconnect and a daemon restart (where busy threads turn into "interrupted"
  errors) never alert.
* **Focus**: `document.hasFocus()` at the evaluation. In WKWebView the page has focus
  while the window is key: an in-app dialog keeps it, another app takes it. Focus is only
  read when something enters the set, so no focus listeners are needed. AppKit also
  ignores the bounce while the app is active.
* **Cooldown**: one timestamp for the alert as a whole (bounce and, in PR 2, sound fire
  together). The first trigger fires at once; triggers within `cooldown_seconds` of the
  last fired alert are dropped, not queued (a dropped one does not extend it); 0 means
  no cooldown. With bounce and sound both off nothing fires and the cooldown is not
  consumed. `DockAlertsDeps.playSound` is the PR 2 hook (a no-op for now).
* No command: these are background behaviours, not user actions.

## Gotchas

* Several "Code Foundry" processes may run at once (other worktrees' builds). Find yours
  with `lsappinfo list | grep -B4 "pid = <pid> "`, then
  `lsappinfo info -long "ASN:0x0-0x…:" | grep StatusLabel` shows the badge
  (`{ "label"="3" }`, `kCFNULL` when removed): a badge check without a screenshot.
* The GUI logs `dock bounce` (stderr) on every Bounce, the only trace a bounce leaves.

## Verified live (isolated `CODE_FOUNDRY_HOME`, three fake disconnected "finished"
threads inserted into `sessions`, no Claude sessions)

* Badge "3" right after launch; `settings set notifications.dock_badge false` removed it,
  `true` brought it back.
* Archive and unarchive with `session archive --id … --archived[=false]` while the GUI
  was frontmost: badge 3 → 2 → 3, no bounce. With Finder frontmost: a bounce. A second
  transition inside the 60 s cooldown: none. `cooldown_seconds 0`: a bounce. `bounce
  false`: none, the badge still moved.
* Daemon killed, a fourth attention thread inserted, daemon restarted: the GUI
  reconnected with badge "4" and no bounce (the new epoch is a baseline).
