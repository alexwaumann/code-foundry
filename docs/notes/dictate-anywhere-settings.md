# Dictate anywhere: settings, daemon, menu bar item (2026-11-03)

One PR of the "dictate anywhere" series: hold Option anywhere on the Mac, speak, release,
and the text is pasted into the frontmost app. This one adds the settings, puts them on
the snapshot, keeps the model loaded, drops the ⇧⌘M default and adds the menu bar item.
The overlay window is another PR; a later one wires the hold key and paste (`gui/althold*.go`,
`gui/paste*.go`), and adds the Accessibility row. Until then `dictation.hold_key` and
`dictation.sounds` are read by nothing, and `dictation.anywhere` only changes the menu bar
item and what closing the window does.

## Decisions

* **Settings.** `dictation.anywhere` (off), `dictation.hold_key` (`left`, `right`, `both`,
  which means either key works; default `both`) and `dictation.sounds` (on, at `notifications.sound_volume`). All
  live. A file without them reads the defaults with no issue, so no migration. A bad
  `hold_key` falls back to the default and is kept in the file with an "Ignored" comment,
  like any rejected value.
* **`dictation.toggle` stays bindable.** It lost its default chord, not its row on the
  Keybindings page. `NoKeybinding` would have turned a settings file's override into an
  issue. A file that binds `cmd+shift+m` keeps working: the mic's tooltip and the search
  dialog's hint and chord follow whatever is bound, and show nothing extra when nothing is.
  The mic's tooltip is then just "Dictate", the icon's name.
* **The store passes `Prefs` on without acting on them.** `ConfigChanged` used to return
  early when `enabled` had not changed, and `equal` decides whether a snapshot publishes, so
  both had to learn the new fields. `hold_key` is a string on the wire, like the setting.
* **The model never unloads on idle.** The presence unload is gone, with `Attended`,
  `AttendedChanged` and the idle timer: the hold key must start at once however long the
  user was away. The engine stays resident while dictation is on (about 1.2 GB). Memory
  pressure still unloads it and `UNLOADED` means only that now; the next Start loads it.
* **An unload racing a load.** `reconcile` set the phase to Ready after load's reply even
  if the engine's `unloaded` event had been handled first. Nothing used to clear that, and
  with no presence reload it would have stuck: the snapshot said Ready with no model. It
  now moves to Ready only from Loading.
* **Hidden rows.** `hold_key` and `sounds` have `DependsOn: dictation.enabled`, and
  `hiddenFields.ts` lists them as rows left out while it is off, rather than dimmed like
  other dependents. A frontend list, not a schema field, so the proto and every test
  fixture stay as they are. The settings search leaves them out too. They follow
  Dictate anywhere, not the switch, so the indented-under-parent style does not apply.
* **The menu bar item.** `gui/menubar.go` is the logic (table tests, no cgo),
  `gui/menubar_darwin.go` the Wails and AppKit side. It follows `dictation.anywhere` from
  `DictationService.Watch`, never from a heartbeat (it carries no settings) and not on a
  lost stream: a daemon restart must not take the item from a hidden window. It shows
  whether or not `dictation.enabled` is on, as the brief says it follows `anywhere`.
* **The icon** is lucide's anvil (`gui/build/menubaricon.png`, 48 px, black on clear). A
  microphone would read as "listening" all day. Wails sets the image to the bar's
  thickness, so the PNG carries its own margin.
* **Closing is a `WindowClosing` hook** that cancels and hides, which covers the red
  button and File › Close Window. The page stays alive while hidden.
* **Turning the setting off with the window hidden shows the window.** Nothing else could
  reach it.

## Gotchas

* **AppKit's last-window check is not tied to the close.** The first version turned
  `shouldTerminateWhenLastWindowClosed` back on before the window was visible again. Open
  after File › Close Window then quit the app, cleanly, every time (no crash, no log), while
  the red button survived. The rule now goes off before the window is ordered out and on
  only after it is back. It stays on while a window shows, so nothing needs to touch it at
  launch, where Wails sets it from the options.
* The rule cannot stay on while hidden for another reason: with the main window hidden the
  About panel is the last window, and closing it would quit.
* `AppDelegate` is private to Wails, so its property is set with KVC behind a
  `respondsToSelector:` check. A Wails upgrade that renames it would bring back quitting on
  the last window, not a crash.
* `Quit`, ⌘Q and `Relaunch` all reach `App.cleanup`, which calls `Close` on every window.
  `app.OnShutdown` runs before that and sets `quitting`, or the hook would cancel those.
  It runs on the main thread, so `quitting` is an atomic outside `menuBar.mu`: a host call
  holding `mu` may be waiting on that thread.
* A fullscreen window leaves fullscreen first; hiding it directly would leave an empty Space.
* Accessory to regular makes a new Dock tile, so the icon goes back on (`icon.go`) and the
  badge is applied again.
* Wails's `SystemTray.New` runs at once when the app is running, so the icon and menu arrive
  through `impl`, and no right-click handler is set. Left and right clicks both get native
  menu tracking.
* A CLI that auto-starts the daemon hands it its stdout. `code-foundry ... | tail` then
  never ends.

## Relaunch and restart

`app.relaunch` and `app.restart` work with the window hidden: the watcher runs regardless
of the window, and `Relaunch` quits through the path above. The new process always starts
visible and regular, with the item back from its first snapshot. The hidden state is not
carried over; those verbs are rare and explicit, so a visible window says it happened.

A hidden host counts as a connected window for those verbs, and its watchers still start the
daemon when it is down, as an open window's do. Only now that host can be there for days.

## Open

* **A second launch makes a second host.** Nothing stops it today, but a hidden first
  instance makes it likely: the only way back in is the menu bar item, and `code-foundry gui`
  starts another process, with its own item and window. Both hosts would capture a session's
  microphone. Wails's `SingleInstance` would change behaviour with the setting off, so this
  needs a decision.
* While hidden the page keeps its streams, so a thread open in it keeps its `WatchThread`.

## Verification

`/tmp/cfda-*` homes, never `~/.code-foundry`. Apple M3 Pro, macOS 27.0.

CLI and daemon: defaults, all three set through `settings set`, `alt` refused, and a hand
edit of the file reached `dictation status --json` live with dictation off. A file from
before this change read the defaults, no issue, its `dictation.toggle` chord intact. The real
model downloaded, the engine loaded it, and with no window attached it stayed Ready for
about 12 minutes: one engine start, one load, and `dictation start` took 41 ms.

Built GUI (`make gui-build`, a scratch home), read through System Events and `lsappinfo`:

* Setting on: the item shows, template image on a dark menu bar. Real left and right clicks
  open the menu, Open and Quit.
* Red button and File › Close Window: no window, application type UIElement, the previous
  app is frontmost, the process lives. Open: Foreground, same frame, app menu works, Dock
  tile has the real icon. Three rounds of each.
* Fullscreen, File › Close Window: hidden, and Open comes back windowed.
* About open, main window closed, About closed: the app stays.
* ⌘Q with the window showing, after a hide and Open cycle; Quit from the item while hidden.
* `app.relaunch` and `app.restart` while hidden: a new process, one GUI, visible, new daemon
  for the restart.
* Setting off while hidden: window back, item gone. Setting off: red button quits.
* Turned on and off while running: the item follows.

Not checked live: a light menu bar (the wallpaper here gives a dark one), the Dock badge
after a hide and Open (no thread needing attention; `TestDockBadgeRedraw` covers it), a real
memory-pressure unload (fake engine only, as in `dictation-2-daemon.md`), and a minimised
window closed through the Window menu.
