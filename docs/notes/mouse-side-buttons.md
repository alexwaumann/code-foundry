# Mouse side buttons step back and forward

A user asked for the mouse's buttons 4 and 5 to run the app's back and forward. They run
`view.back` and `view.forward` (docs/notes/selection-history.md), the browser and Finder
convention: button 4, the rear thumb button, goes back; button 5, the front one, goes forward.

## Why the host and not the page

WebKit on macOS reports every button past the third as the middle button (`button` 1 on the
DOM event), so the page cannot tell back from forward. The host installs an
`NSEvent` local monitor for other-mouse down/up (`gui/mousebuttons_darwin.go`). For
`buttonNumber` 3 and 4 it emits `EventRunCommand` with the command name on the press, the
same path the app menu uses, so `startCommandNamed` runs the window-local presenter
(`historyCommand`). The mouse adds no user action of its own.

* Both the press and the release of a mapped button are consumed, so WebKit never sees a
  stray middle click.
* The emit runs on its own goroutine: the monitor runs on the main thread and emitting
  may wait for it.
* The mapping is fixed (`mouseButtonCommands` in `gui/mousebuttons.go`), not a rebindable
  keybinding; chords are keys only. Revisit if someone asks to rebind the buttons.
* A cgo file with C definitions in its preamble cannot also `//export`, so the Go
  callback lives in `gui/mousebuttons_export_darwin.go`.

## Verified

The built app on an isolated home: `view.projects`, then a synthesized
`kCGEventOtherMouseDown`/`Up` with button number 3 went back to the composer home, and
button number 4 went forward to Projects again.
