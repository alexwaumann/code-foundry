# Native zoom

UI zoom (`appearance.zoom`, cmd+= / cmd+- / cmd+0) is the webview's own page zoom, set by
the Wails host, in place of CSS `zoom` on `<html>`. This note replaces `ui-zoom.md`,
`zoom-popovers.md`, `toast-zoom.md`, `frame-page-zoom.md` and `file-edit-zoom.md`, which
describe the CSS-zoom design and the bugs it caused.

## Why

CSS zoom lays the page out at the scaled size but keeps rects and pointer events in
viewport px, so the page had two coordinate systems. Every place that measured (floating
surfaces, drags, find highlights, virtual lists, viewport units, toasts, frames, the
terminal canvas) had to convert, about 80 sites, and each new one was a bug until someone
zoomed. Under the webview's page zoom the page has one coordinate system, as under a
browser's zoom: nothing in the page compensates.

Wails 3.1.0 made it possible: `Window.SetZoom` is `WKWebView.pageZoom` there, which lays
out again (before 3.1.0 it was magnification, which does not).

## How

- `AppService.SetZoom(percent)` (`gui/app.go`) calls `window.SetZoom`, re-centres the
  traffic lights and saves the percent in `window-zoom.json` (`gui/windowzoom.go`).
- The page calls it from `lib/zoom.ts` on start and on each change of the setting. It sets
  nothing on the page but `data-zoom` on `<html>`.
- At launch the host applies the saved percent after the page has loaded and before the
  window shows (`restoreZoom` in `main.go`), so the window never opens at 100% and jumps.
  The daemon's settings are not reachable that early, hence the host's own file, like the
  window background.
- The title band's maths is unchanged: the lights are native and keep 80 screen px, so the
  gutter is `80 / zoom` CSS px (`titleBand.ts`), and the host centres the lights on the
  zoomed band (`trafficlights_darwin.go`).

## What changed for a user

- A page in a frame (an HTML file tab, an inline page, a plugin page) zooms with the app.
  Under CSS zoom the frame undid the zoom and pages stayed at 100%.
- A terminal's font is the setting's size times the zoom exactly (19.5px at 150% for 13pt)
  where it was rounded to a whole px (20), so a line can hold a column or two more.
- Nothing else: measured in the real window at 90, 100, 125 and 150%, eleven surfaces, every
  rect within 1.5px of the CSS-zoom build and the chrome identical pixel for pixel.

## Gotchas

- **File drops.** Wails hands a native file drag's position to the page in view points and
  looks the target up with `elementFromPoint`, which takes CSS px. Under page zoom they
  differ by the zoom, so a drop landed on the wrong element or outside the page.
  `scaleNativeDrops` (`api/app.ts`) wraps the runtime's two hooks and divides. It also
  rounds: the host decodes the position as Go ints and refuses the whole drop on a
  fraction, silently.
- **`devicePixelRatio` is multiplied by the zoom** (2 becomes 3 at 150% on a Retina screen)
  and `innerWidth` divided by it. A canvas sized from `devicePixelRatio` (xterm's WebGL
  canvas, PDF pages) is sharp with no handling. `window.outerWidth` is 0 in WKWebView, so
  the page cannot derive the zoom from it: the store's value is the zoom.
- **Wails ignores `WebviewWindowOptions.Zoom`** at creation (the call is commented out in
  3.1.0), so the launch zoom is a `SetZoom` call once the window exists.
- **No zoom without a host.** The browser dev frontend, `make drive` and the e2e suite have
  no app zoom; the browser's own zoom does the same thing. The store still holds the
  percent, so the title band's gutter still follows it there.
- **Testing.** Zoom is not in the e2e suite any more: the specs that only checked zoom
  compensation are gone, and tests that used 200% to get a small window set a small
  viewport. What is left to check is the host seam, in the real window with
  `make gui-drive` (`gui-drive.md`, "Host checks"); a Finder drop, the window drag and
  the pane gutter drags are checked by hand.
- **The `@pierre/diffs` patch** still divides by `element.currentCSSZoom` in a dozen
  places. That is 1 now, so the code is inert; it leaves with the next rework of that
  patch.
- **The `@wailsio/runtime` patch** lost its drag-zone hunk (it scaled the client box by the
  CSS zoom); the timer hunk stays.

## Alternatives considered

- Three density levels plus a base text size in place of free zoom: no zoom machinery at
  all and testable anywhere, but layouts must hold for every combination, and about 180
  fixed px classes and 80 JS size constants would need an audit. Not ruled out for later.
- Keeping CSS zoom as a fallback without a host: it would keep every workaround alive.
