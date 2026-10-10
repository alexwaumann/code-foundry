# UI zoom (cmd+= / cmd+- / cmd+0)

Before: the chords only changed the terminal font (appearance.font_size). Now they zoom
the whole window like T3 Code (Electron's `webContents.setZoomLevel`, ±0.5 steps).

## Decisions

- **CSS `zoom` on `<html>`** (`gui/frontend/src/lib/zoom.ts`), not WKWebView zoom: Wails
  v3 only exposes `magnification`, which scales the rendered page without reflow.
  WebKit implements the standardized zoom model (verified in Playwright WebKit):
  `getBoundingClientRect` and mouse events stay in viewport px, layout px are divided.
- **Setting `appearance.zoom`** (int percent, 90–200, default 100) in the daemon schema;
  the chords step a browser ladder (90, 100, 110, 125, 150, 175, 200; Alex capped it at 90–200) and
  save one write per burst, like the old font zoom. `appearance.font_size` stays the
  terminal font size *before* zoom and is only edited on the settings page.
- **Terminal**: xterm's WebGL canvas is sized from `devicePixelRatio`, which CSS zoom
  does not change, so a zoomed canvas is resampled (blurry). The terminal host undoes
  the zoom (`zoom: 100/zoom`) and the font size is `round(font_size * zoom / 100)` instead.
  Nested zooms multiply, so the host lands at effective 1.0: its local px are viewport px
  and the canvas backing store is exactly dpr × its CSS size (probe-verified at 80/150%).

## Gotchas

- **Viewport units ignore zoom.** `100vh` stays the whole window, so under `zoom: 1.5`
  it overflows by 50%. The app root is `h-full` on the html/body/#root 100% chain; the
  few `vh`/`vw` offsets (dialogs, help overlay, empty states, attachment preview) divide
  by `--cf-zoom`, set on `<html>` with the zoom.
- **`documentElement.clientWidth` stays in viewport px** in WebKit; `body.clientWidth` is
  in layout px. `layoutWidth()` uses the body, and `startZoomSync` re-measures after each
  zoom change so `panelMax` hides the side panel when it stops fitting.
- A press count mistake: three cmd+= presses reach 150%, not four.

## Traffic lights

The three window buttons are native (hidden-inset title bar), so CSS zoom cannot scale
them. T3 Code does not scale them either: it calls Electron's `setWindowButtonPosition`
with `y = round(52 * zoomFactor / 2 - 7)` so they stay centred in the zoomed top bar
(`src/window/DesktopWindow.ts` in its bundle). We do the same:

- `gui/trafficlights_darwin.go` (cgo/ObjC, ~40 lines): sets the y origin of the three
  `standardWindowButton`s so they centre on `52 * zoom / 2` points below the top edge.
  AppKit re-lays the title bar on resize and when leaving full screen, so the target is
  kept in an associated object on the NSWindow and re-applied from
  `NSWindowDidResize/DidEndLiveResize/DidExitFullScreen/DidBecomeKey`. Skipped in full
  screen (the system owns the buttons there). Wails v3 beta.28 has no public API for
  this; `WebviewWindow.NativeWindow()` gives the NSWindow.
- `AppService.SetZoom(percent)` is the bound entry point; the frontend calls it from
  `applyZoom` (lib/zoom.ts -> api/app.ts setHostZoom) on start and after each change,
  no-op outside the Wails host. `AppService.window` is set by main (an exported setter
  would be bound too and drag a Wails model into the bindings).
- Horizontally the page keeps an 80 *screen* px gutter clear for them
  (`trafficLightGutter(zoom)` in titleBand.ts): narrower in layout px when zoomed in.
- Verified live (isolated CODE_FOUNDRY_HOME, real cmd+= keystrokes, screencapture):
  centred at 80%, 100% and 150%, no overlap with the Threads header.

Alternatives considered: HTML-drawn buttons with the native ones hidden (zoom for free,
but lose the native look, full-screen behaviour and accessibility); keeping the band at
52 screen px by shrinking its layout height (breaks the pane headers' alignment).

## Drag zones

The window drags from the sidebar band, the pane headers and the 8 px sheet edge
(`--wails-draggable: drag`, handled by the Wails JS runtime). Under zoom only the
top-left 1/zoom of each surface dragged: the runtime's `isDraggableEvent` (drag.ts) keeps
the press inside the target with `offsetX < clientWidth && offsetY < clientHeight` (to
skip scrollbars), and under CSS zoom WebKit reports `offsetX/Y` in viewport px while
`clientWidth/Height` stay layout px (probe-verified). Fixed with a pnpm patch
(`gui/frontend/patches/@wailsio__runtime@3.0.0-beta.28.patch`, wired in
pnpm-workspace.yaml `patchedDependencies`): the client box is scaled by the target's
effective zoom (`getBoundingClientRect().width / offsetWidth`). The patch is pinned to
the runtime version, so a Wails upgrade fails install loudly until it is re-applied or
upstreamed. Verified live with synthesized CGEvent drags (a 20-line Swift tool; cliclick
and pyobjc are not installed): at 150% the window followed drags from the band's lower
part and from the far right of a pane header, and still drags everywhere at 100%.
