# Phase 3 UI: hidden-inset title bar, sheet and panes

Status: done on `t3code/customize-window-title-bar`. `make check` is green (Go, 22 vitest
files / 293 tests) and `make gui-e2e` passes 108/108 (54 WebKit, 54 Chromium). The real app
(`make gui-build`, `gui/bin/CodeFoundry`) ran on macOS 27.0.1 against a daemon with an
isolated `CODE_FOUNDRY_HOME`, in dark and light.

## What changed

* `gui/main.go`: `Mac: MacWindow{TitleBar: MacTitleBarHiddenInset, InvisibleTitleBarHeight: 52}`
  and `BackgroundColour` = the dark sheet, `NewRGB(0, 0, 0)` (was `NewRGB(7, 7, 7)`, see
  `phase3-ui-buttons.md`). `Title` stays set, and
  `lib/title.ts` keeps setting it, so Mission Control and the app switcher still show it.
* `components/window/TitleStrip.tsx`: a full-width, 52px strip on the sheet with an 80px
  traffic-light gutter. It holds nothing interactive.
* `App.tsx`: the root is the sheet (`bg-sheet`). `<main>` is the one pane
  (`data-testid="content-pane"`): `mx-2 rounded-lg border border-pane-border bg-pane shadow-xs`.
* The sidebar loses `border-r` and sits on the sheet. (The footer was later removed; its
  daemon status moved to the foot of the sidebar, see `phase3-ui-buttons.md`.)
* Pane headers (terminal, settings and its nav, Pull Requests, worktree overview) use
  `border-pane-border`.

## Tokens (`src/index.css`)

New tokens, mapped in `@theme inline` as `bg-sheet`, `bg-pane`, `border-pane-border`:

| Token | Dark (`.dark`) | Light (`:root`) |
|---|---|---|
| `--sheet` | `#000000` (was `oklch(0.13 0 0)`, #070707) | `oklch(0.955 0 0)` (#f0f0f0) |
| `--pane` | `#0a0a0a` (first `#171717`, then `#101010`; both read too light) | `#ffffff` |
| `--pane-border` | `oklch(1 0 0 / 11%)` (was 8%; the pane is only 10/255 above the sheet) | `oklch(0 0 0 / 8%)` |

Aliases: `--background`, `--sidebar` and `--sidebar-border` are `var(--sheet)`. `--card`,
`--popover` and `--terminal-bg` are `var(--pane)`. The sidebar therefore matches the app
background by construction, and its border is invisible wherever it is still used.

Accent changes so selection stays visible on the sheet: light `--sidebar-accent` goes
0.97 → 0.91 (0.97 vanished on a 0.955 sheet). Dark goes 0.269 → 0.235, which keeps about
the same step above the darker sheet.

`--pane` is a hex value, not oklch, because the xterm theme needs a colour xterm can parse.
`src/terminal/theme.ts` dark `background`/`cursorAccent` went `#0b0b0c` → `#101010` → `#0a0a0a`, and
light stays `#ffffff`. Comments in both files tie them together. `e2e/layout.spec.ts`
asserts the xterm theme background equals the pane's computed colour in both schemes.

## Strip height: 52, not 38

Measured on macOS 27 from a window screenshot and an AppKit replica: Wails' `HiddenInset`
preset is an empty `NSToolbar`, transparent title bar, full-size content. With it the
traffic lights sit at x 19–79 pt, y 19–33 pt, centred on y=26. A 38px strip leaves them 5pt
above its bottom edge, crowding the pane when the sidebar is hidden. 52px centres them
(19pt above and below), the same band height AppKit draws for a toolbar window. The
gutter is 80px because the zoom button ends at x=79. `TITLE_STRIP_HEIGHT` (TS) and
`titleStripHeight` (Go) must change together.

## How dragging is wired

* Native: `InvisibleTitleBarHeight: 52`. Wails' app-wide mouse-down monitor calls
  `performWindowDragWithEvent` for any first click in the top 52pt, at least 5pt from the
  left and right edges (so corner resizing still works). Wails applies it only when the
  title bar is transparent or the window is frameless, so it requires the HiddenInset
  preset.
* Runtime: the strip has `[--wails-draggable:drag]` (Tailwind arbitrary property). The
  `@wailsio/runtime` drag module is loaded as a side effect of the existing import in
  `lib/title.ts`. On mouse-down over a draggable element it sends `wails:drag`. A
  double-click sends `wails:drag:doubleclick`, which runs the system's title-bar
  double-click action (zoom or minimise, per System Settings). The native handler skips
  `clickCount != 1`, so the double-click reaches the runtime.
* `--wails-draggable` inherits, so a future interactive child needs
  `[--wails-draggable:no-drag]`. Even then the native band still begins a drag on its
  mouse-down. Keep controls out of the strip, or lower `InvisibleTitleBarHeight` to
  match.

## Gotchas

* With the toolbar present, AppKit hit-testing still routes every point outside the
  traffic lights to the WKWebView, including inside the 52pt toolbar band. Checked with
  a replica window (`NSView.hitTest`). Content just below the strip is clickable.
* In the replica with Wails' monitor logic, a stationary click inside the native band
  still reached the web content, and a click on the close button still closed the window.
  Only a real mouse-drag moves the window.
* Fullscreen: macOS hides the traffic lights and the toolbar. The strip and gutter stay,
  leaving an empty 52px band. The app does not listen for fullscreen events. Collapsing
  the strip in fullscreen would be a later change.
* `wails3 build` runs `go mod tidy`, which drops a blank line in `go.mod`. Revert it, do
  not commit it.
* Pre-existing, not changed here: amber attention text (`text-amber-300`) is hard to
  read on the light sheet.

## Verification

* `e2e/layout.spec.ts` (new) covers:
  * the strip spans the window at 52px with `--wails-draggable: drag` and an 80px gutter;
  * the sidebar and pane start below the strip, with the sidebar shown and hidden (⌘B);
  * the pane is 8px from the right edge;
  * the sidebar background equals the sheet and has no right border;
  * the pane differs from the sheet;
  * the xterm theme background equals the pane, in dark and light.
* Live, with `gui/bin/CodeFoundry` and an isolated home, a registered scratch repo, and a
  terminal opened and focused through the CLI (`terminal.new`, `ui.focus.terminal`):
  * the traffic lights sit in the gutter, centred in the strip;
  * sampled colours: sheet (7,7,7), pane and terminal (16,16,16) in dark; sheet
    (240,240,240), pane and terminal (255,255,255) in light, after switching with
    `settings set appearance.theme light`.
* Not verified live: dragging the window by the strip, double-click to zoom, and the
  hidden-sidebar layout in the real app. The session had no Accessibility permission, so
  it could not post mouse events, and the sidebar toggle is GUI-only. The AppKit replica
  above and the e2e cover the mechanics.
