# Dock badge and attention alerts

Decided 2026-10-14 (Alex). PR 1 of 2: the Dock badge, the Dock bounce and every
`notifications.*` setting. PR 2: the alert sound (`notifications.sound`,
`notifications.sound_volume`), which fires on the same trigger, the `notifications.test`
command and the settings page's volume slider with Play (see "Alert sound" below).

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
| `notifications.sound` | bool | false |
| `notifications.sound_volume` | int 0–100 | 50 (percent of the Mac's output volume) |
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
* **Focus** (changed in `docs/notes/alerts-foreground.md`): the input is now *attended*,
  `isPageAttended()` at the evaluation: the page is visible and `document.hasFocus()`.
  In WKWebView the page has focus while the window is key (an in-app dialog keeps it,
  another app takes it), and a covered or minimized window reports hidden. It is only
  read when something enters the set; the focus and blur listeners that exist now are
  for reporting the state to the daemon, not for this. The daemon applies the same rule
  over every GUI client: while no window is visible and key, an open thread view no
  longer acknowledges a finished turn, so the thread in the main pane enters the
  attention set and alerts like any other (before, it never did). AppKit also ignores
  the bounce while the app is active.
* **Cooldown**: one timestamp for the alert as a whole (bounce and, in PR 2, sound fire
  together). The first trigger fires at once; triggers within `cooldown_seconds` of the
  last fired alert are dropped, not queued (a dropped one does not extend it); 0 means
  no cooldown. With bounce and sound both off nothing fires and the cooldown is not
  consumed. A sound at volume 0 counts as off.
* No command for the badge and the alerts: these are background behaviours, not user
  actions. The sound's preview is one (`notifications.test`, below).

## Alert sound (PR 2)

* **The sound**: "Soft mallet", a wooden double tap (48 kHz mono 16-bit, 0.6 s,
  loudness-normalised), synthesised by `docs/sketches/alert-sound/wood.py` (`soft`); the
  sketches directory is the design record and its README says how to regenerate.
  `gui/build/alert.wav` is the shipped copy, embedded in the GUI binary (`notify.go`,
  like `dockicon.png` in `icon.go`); `TestAlertWAV` keeps the two copies identical.
* **Host-side, not the webview**: `AppService.PlaySound(volume)` plays it with
  `NSSound` (`notify_darwin.go`), which needs no bundle. WKWebView's autoplay policy may
  refuse audio that does not follow a user gesture, and an alert never does. The NSSound
  is created once from the embedded bytes (`initWithData:`) on the main queue, on first
  use, and kept in a static for the life of the process. Each play `dispatch_async`es to
  the main queue, sets `volume` = percent / 100, stops a sound still playing and plays it
  again. The binding clamps to 0–100, does nothing for 0, logs `alert sound volume=N`
  (stderr, like `dock bounce`) and returns at once.
* **Volume** is relative to the Mac's output volume (NSSound's `volume`), so 100 is the
  system volume, never louder; muted output mutes it.
* **Focus and Do Not Disturb**: the alert's trigger is the same as the bounce's (a thread
  enters the attention set while the app is unfocused, outside the cooldown). Focus / Do
  Not Disturb is not detectable here: the only API, `INFocusStatusCenter`, needs an
  entitlement and the user's authorization, which a bare unsigned executable cannot get,
  and Focus silences notifications, not NSSound. So the sound plays during Focus too;
  that is one reason it is off by default.
* **`notifications.test`** ("Notifications: Play Alert Sound", category Settings) makes
  every connected GUI play the sound once through a new `UiIntent.PlayAlertSound
  {volume}`: a preview, regardless of focus, cooldown and the `notifications.sound`
  toggle. The volume is the optional `--volume` arg (0–100, else InvalidArgument), else
  the daemon's `notifications.sound_volume` (the default 50 when the value is missing or
  does not parse). It reports `alert sound at N%: delivered=K` (the CLI prints it; the
  palette toasts it) and `{"delivered":K}` as JSON. The volume rides on the intent, so the
  GUI never reads it from its own settings store, which may lag the daemon by an event.
  The GUI's `stores/intents.ts` calls `playAlertSound` (`api/app.ts`, a no-op without a
  host).
* **Settings page**: `notifications.sound_volume` renders as a slider (shadcn's Slider,
  added as `components/ui/slider.tsx` over radix-ui) with its value and a Play button.
  Per-key editors live in a small registry, `components/settings/keyEditors.ts`, consulted
  before the per-type editors; `VolumeEditor.tsx` is its first entry. Dragging only moves
  the slider; the setting is saved on release (Radix's `onValueCommit`, which also fires
  once per keyboard step), so a drag is one save. The slider is not disabled while a
  save is in flight: that would take the keyboard focus off the thumb. Play runs
  `notifications.test` through the command runner (`runCommandForResult`, quiet: no
  toast) with `--volume` set to the slider's current value, so it always plays what the
  slider shows, even before that value's save has landed; this was simpler than waiting
  for the save. Play is disabled at 0.
* Every connected window plays a `notifications.test` (the intent is broadcast like
  `ui.notify`); with one window that is the one the user clicked.

## Gotchas

* Several "Code Foundry" processes may run at once (other worktrees' builds). Find yours
  with `lsappinfo list | grep -B4 "pid = <pid> "`, then
  `lsappinfo info -long "ASN:0x0-0x…:" | grep StatusLabel` shows the badge
  (`{ "label"="3" }`, `kCFNULL` when removed): a badge check without a screenshot.
* The GUI logs `dock bounce` (stderr) on every Bounce, the only trace a bounce leaves,
  and `alert sound volume=N` on every PlaySound. That the sound really played shows in
  the unified log: `log show --predicate 'processID == <pid>' --last 1m | grep
  AudioQueue` has a "New output; format 1 ch, 48000 Hz, Int16" line per new player.
* jsdom has no ResizeObserver, which Radix's Slider needs: `VolumeEditor.test.tsx`
  stubs it.

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

## Verified live, PR 2 (same isolated home, four fake threads, volume 15)

* `code-foundry notifications.test` printed `alert sound at 15%: delivered=1`; the GUI
  logged `alert sound volume=15` and the unified log shows CoreAudio opening an
  AudioQueue output for the 48 kHz mono Int16 WAV.
* `notifications.sound true`, `cooldown_seconds 0`, Finder frontmost, then
  `session archive --id fake-1 --archived` and `--archived=false`: `dock bounce` and
  `alert sound volume=15` together. With `bounce false`: `alert sound` alone.
* `notifications.test --volume 0` delivered and played nothing; `--volume 101` exited 2
  with "volume 101 is outside 0–100".
