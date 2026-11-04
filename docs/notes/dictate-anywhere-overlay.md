# Dictate anywhere: the overlay (2026-11-04)

Hold a key anywhere on the Mac, speak, release, and the text is pasted into the frontmost
app. This PR is the on-screen part: a small plate under the menu bar that shows listening,
working and done. The settings and the menu bar are `dictate-anywhere-settings.md`; the hold
key and paste come later. Until then a session with client id `system` drives it:
`code-foundry dictation.start --client system`, then `dictation.stop`.

## What shipped

* `gui/overlay.go` (pure Go, tested): where the panel goes (`overlayFrame`, `overlayScreenAt`)
  and when it shows and hides (`OverlayService`, bound to the page).
* `gui/overlay_darwin.go`: the panel itself and what Wails has no option for.
* `dictation-overlay.html` + `src/overlay/`: a second Vite input with no React, no app CSS
  and none of the stores. `scope.ts` is the approved sketch's simulation and drawing;
  `phases.ts` the reducer from daemon state; `levels.ts` the smoothing; `controller.ts` the
  frame loop. `src/api/overlay.ts` holds what touches the host and the daemon.
* Daemon: `DictationSession.stopping`, `DICTATION_END_REASON_DISCARDED`, `UiService.GetTheme`.
* `public/HEX-LICENSE.md`: the structure and constants come from Hex (MIT). It is under
  `public/` so it ships in the app; the bundler strips the comment in `scope.ts`.

## Decisions

* **The hidden page holds nothing.** No stream, no timer, no animation frame. The host's own
  Watch sees the session and wakes the page with its id (`dictation-overlay:begin`); the page
  then opens Watch and Session, and closes them when the plate has faded. This is the brief's
  "Drawing runs only while visible" taken to streams too.
* **The page uses `localhost`, not `127.0.0.1`.** Both webviews share WebKit's network session
  and its six connections per host (`api/streamSlots.ts`), and the main window may hold five
  streams and need the sixth for its calls. Two more would hang it for the length of a
  dictation. The daemon accepts both names and CORS goes by the origin. That the session is
  shared comes from how WebKit is built and was not measured here.
* **`DISCARDED`, not just `stopping`.** Watch and Session are separate streams, so `ended` can
  beat the snapshot that says stopping. With one reason for both kinds of Stop, a fast flush
  would look like a discarded press. So STOPPED means a flush happened, seen as working or not,
  and goes to done. `stopping` is only ever set for a flush.
* **Theme by a unary `GetTheme`, read on each show and once a second while showing.**
  `/cf/theme.json` is on the pages listener, whose port the page does not have and whose
  paths the API listener 404s. A stream would hold a connection for a plate that shows for
  seconds. The theme engine itself would pull the catalog and the settings stream into a page
  that needs six colours.
* **The panel is created on `dictation.anywhere`, or on a first session without it** (the CLI),
  then kept. A first show waits for the page: see below.
* **A window with the session gone hides after 3 s anyway** (`overlayLinger`): the page needs
  under 1 s, and a dead page must not leave the plate up. A hidden session is remembered, so a
  reconnecting watcher does not show it again.
* **The plate stays on the screen it opened on.** It is placed at each show, on the pointer's
  screen, and does not follow the pointer during a session.
* **Window size 144 x 52**, plate centred in it, so the page needs no position from the host
  and centres itself. Its transparent margin reaches 7 pt into the menu bar area.
* **Reduce Motion does not apply:** the plate is a small status light, not page motion, so it
  always animates, as Ember does. A meter mode shipped in #526 and was removed.
* **A denied microphone collapses** (the host stops the session without flush), for now with
  no explanation. The paste PR decides what that says.

## Gotchas

* **Wails' transparent backdrop is not enough.** With `MacBackdropTransparent` and
  `BackgroundTypeTransparent` the panel was an opaque white rectangle. `clearWebViewBackground`
  after `WebViewDidFinishNavigation`, as the main window does, fixes it. Unit tests cannot see
  this, and neither can the browser e2e.
* **Before that navigation the panel is an opaque black rectangle**, so a first show waits for
  it (`overlayWindow.waiting`). The page gets the session from `PageReady`, not the event it
  was not yet listening for, and its frame loop starts once the window is in.
* **NSPanel hides when its app deactivates by default**, and this app is rarely active here:
  `hidesOnDeactivate = NO`. `canHide = NO` keeps it through ⌘H.
* **Frameless alone is still a titled window** in Wails. `MacWindowCornerTypeSquare` is what
  makes it borderless; AppKit keeps titled windows out of the menu bar.
* **`NativeWindow()` may still be nil** when the setting creates the panel before the app runs,
  so `cfOverlayConfigure` runs at navigation, not after `NewWithOptions`.
* `NSEvent.mouseLocation` reaches a screen's top edge inclusive, so a pointer in the top row
  belongs to that screen.
* `visibleFrame` reaches the top of a notched screen when a full-screen Space hides the menu
  bar; `safeAreaInsets.top` keeps the plate under the notch.

## Verification

`make check` green. Vitest: the reducer, the simulation, the level follower, the colours and
the frame loop (`src/overlay/*.test.ts`). Go: geometry, show and hide, the watcher
(`gui/overlay_test.go`), `stopping` and the end reasons, `GetTheme`. One e2e: the second input
loads and paints a real canvas in the theme. The TypeScript scope was also stepped against
the approved `scope.js` over the whole timeline, success and failure: every dot, the width,
alpha and the rest agree to under 1e-4 (not committed; the sketch is outside the repo).

Live on an Apple M3 Pro, macOS 27.0, one notched display (2056 x 1329 pt), the built GUI on a
scratch `CODE_FOUNDRY_HOME`, sessions from the CLI. A throwaway frontmost AppKit app logged
every change of key or active status at 120 Hz and from notifications.

* Focus: across every session the frontmost app logged no change at all and stayed key.
  `System Events` keystrokes reached its text field with the plate up, and ⌘V reached its menu
  item both with the plate up and just after. Nothing was pasted: it logged the chord.
* Placement: layer 25, 956,32 144 x 52, so the plate's top is 6 pt under the 39 pt bar, centred.
* Sessions for `cli` and a composer-like id never showed it.
* Phases: listening follows the voice (real `say` speech streamed through
  `DictationService.Audio`, transcribed); working narrows with the light; done clears from the
  middle and collapses; `--flush=false` collapses with no done look; killing the engine ended
  it ERROR and showed the error colour, then hid.
* Themes: GitHub Dark and Light, Tokyo Night. In GitHub Light and Tokyo Night, where accent and
  info match, working reads by its width and the moving light. A theme changed during a session
  reached the plate within a second.
* Full screen: over a full-screen app, under the notch, the app kept focus.
* `dictation.anywhere` on: the panel exists before any session; with the main window closed
  and the app in the menu bar it still shows. With the setting off, closing the main window
  still quits, the hidden panel does not keep the app alive.
* The Window menu lists only the main window; the panel is not an accessibility window while hidden.
* Memory, hidden, after a session: the panel's WebContent process 28 MB, the host 48 to 49 MB
  (the main window's WebContent, for scale, 162 MB). CPU: 5 to 6.5% of a core for WebContent
  while showing, 0.0% hidden.

Not checked: two displays (one attached). The real microphone: this build's permission prompt
went unanswered, so levels came through `Audio`, not AVAudioEngine. Mission Control, whose
`Transient` behaviour is set but was not looked at. The linger's hide and a daemon restart during
a session are covered by tests only.
