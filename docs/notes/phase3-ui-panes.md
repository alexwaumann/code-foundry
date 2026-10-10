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
  traffic-light gutter. It holds nothing interactive. (Removed since: see "Panes reach
  the window top" below.)
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
| `--pane` | `#060606` (first `#171717`, then `#101010`, then `#0a0a0a`; all read too light) | `#ffffff` |
| `--pane-border` | `oklch(1 0 0 / 11%)` (was 8%; the pane is only 10/255 above the sheet) | `oklch(0 0 0 / 8%)` |

Aliases: `--background`, `--sidebar` and `--sidebar-border` are `var(--sheet)`. `--card`,
`--popover` and `--terminal-bg` are `var(--pane)`. The sidebar therefore matches the app
background by construction, and its border is invisible wherever it is still used.

Accent changes so selection stays visible on the sheet: light `--sidebar-accent` goes
0.97 → 0.91 (0.97 vanished on a 0.955 sheet). Dark goes 0.269 → 0.235, which keeps about
the same step above the darker sheet.

`--pane` is a hex value, not oklch, because the xterm theme needs a colour xterm can parse.
`src/terminal/theme.ts` dark `background`/`cursorAccent` went `#0b0b0c` → `#101010` → `#0a0a0a` → `#060606`, and
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

## Panes reach the window top (branch `t3code/per-pane-side-panel-width-and-fullscreen`)

The full-width strip is gone. The content pane and the side panel extend up into the
title band, and their headers occupy it.

* `components/window/titleBand.ts`: `TITLE_BAND_HEIGHT` (52, was `TITLE_STRIP_HEIGHT`;
  renamed because there is no strip any more) and `TRAFFIC_LIGHT_GUTTER` (80). Go has no
  copy of the height now: `InvisibleTitleBarHeight` is 0. The comment in `gui/main.go`
  names the TS constant.
* Sidebar (`Sidebar.tsx`, `SidebarBand`): a 52px band, the empty 80px gutter
  (`traffic-light-gutter`), then the Repositories header (title, attention badge, count,
  new thread, new terminal). Pull Requests and the tree follow below the band. (Since
  superseded: the header is the app name with the attention badge and New thread; see
  sidebar-title-band.md.)
* Content pane (`App.tsx`): `m-2`, so it floats 8px from the window top as from its
  other edges. The side panel wrapper gains `mt-2`.
* Every content pane header is a `PaneHeader` (`components/window/PaneHeader.tsx`):
  `h-11` (44px), border, drag. That covers the terminal header (was `h-9`), the worktree
  overview, Pull Requests and Settings. The side panel header is always `h-11` too
  (it used to follow the pane beside it, `h-9` or `h-11`).
* Geometry: the pane has a 1px border, so a header box is y 9 to 53. Its bottom border
  is the first pixel row below the band (y 52). With the sidebar shown, header text is
  centred near y 31, about 5px below the traffic lights' centre (y 26). The task fixed
  the 8px margin and the 44px header, so this offset is accepted.
* With the sidebar hidden, the content pane's top-left corner sits under the traffic
  lights. `PaneHeader` then sets `padding-left: 80px` (TRAFFIC_LIGHT_GUTTER), so its
  content starts at x=89, past the lights. Pages without a header (dashboard, composer,
  disconnected thread) keep their `p-10`. The lights sit in that padding.
* The disconnected thread's absolute panel toggle moved from `top-1.5` to `top-2.5`, so it
  is centred in the 44px band where the other pages have a header.
* The dashboard (no selection) still has no header. It looked right without one.

## How dragging is wired

* Native: none. `InvisibleTitleBarHeight` is 0 (it was 52). Wails' native band calls
  `performWindowDragWithEvent` from an app-wide mouse-down monitor, before the page sees
  the event. With buttons in the band (sidebar header, pane headers, panel tabs) every
  click would have started a drag. Keep `MacTitleBarHiddenInset`.
* Runtime: drag surfaces carry `[--wails-draggable:drag]` (Tailwind arbitrary property).
  They are the sidebar band (gutter and header), every `PaneHeader`, the side panel header
  (`PanelHeader`), and an 8px strip along the window top (`window-drag-edge` in
  `App.tsx`, over the sheet above the panes). The strip is the only drag surface when the
  sidebar is hidden and the page has no header.
* The `@wailsio/runtime` drag module is loaded as a side effect. `lib/title.ts` (and
  `api/app.ts`) import from `@wailsio/runtime`, whose `index.js` imports `./drag.js`. The
  package's `sideEffects` list names `drag.js`, so the bundler keeps it. On a first
  mouse-down (`detail === 1`) over an element whose computed `--wails-draggable` is
  `drag`, the module arms a drag. The next mouse-move sends `wails:drag`, and the host
  calls `performWindowDragWithEvent` with the stored mouse-down event
  (`webview_window_darwin.m`). A `dblclick` on a drag surface sends
  `wails:drag:doubleclick`, and the host runs the system's title-bar double-click
  action (zoom or minimise, per System Settings).
* `--wails-draggable` inherits. Controls are marked `[--wails-draggable:no-drag]`: the
  sidebar band's control cluster, the terminal header's `pane-actions`, `PanelToggle`
  (always), each panel tab (wrapper), the PR scope button, the settings search box and
  its two buttons, and both resize handles. As a safety net, a base rule in `index.css`
  sets `no-drag` on `button, a, input, select, textarea, [contenteditable], [role=tab],
  [role=separator]`. A utility class still overrides it.
* Not draggable: anything outside those surfaces, including the terminal (xterm), page
  bodies, the sidebar tree and Pull Requests entry, the panel body, and the panes
  themselves.

## Gotchas

* The runtime checks the event target's own box: `offsetX/offsetY` must fall inside
  `target.clientWidth/clientHeight`. A non-flex inline element has `clientWidth` 0, so
  pressing on, say, the `@` inside the overview title does not drag. Flex children are
  blockified, so header spans and titles do drag.
* At the default 260px sidebar width the band has 180px right of the gutter. Title,
  attention badge, count and buttons need about 206px. With a thread waiting,
  "Repositories" truncates (to "REPO…"). Without the badge it fits. Open question: drop
  the count, move the badge, or accept the truncation.
* Fullscreen hides the traffic lights, but the gutter (and, with the sidebar hidden, the
  80px header inset) stays. The runtime does not drag in fullscreen (`IsFullscreen`
  check in `HandleMessage`). The app does not listen for fullscreen events.
* With the toolbar present, AppKit hit-testing still routes every point outside the
  traffic lights to the WKWebView, including inside the 52pt toolbar band. Checked with
  a replica window (`NSView.hitTest`). That is what lets the pane headers and the
  sidebar band take clicks.
* (Native band, before the panes reached the top.) In the replica with Wails' monitor
  logic, a stationary click inside the native band still reached the web content, and
  a click on the close button still closed the window. Only a real mouse-drag moved the
  window. A press-and-nudge on a button did start a drag, which is why the native band
  is off now that buttons sit in the band.
* `wails3 build` runs `go mod tidy`, which drops a blank line in `go.mod`. Revert it, do
  not commit it.
* Pre-existing, not changed here: amber attention text (`text-amber-300`) is hard to
  read on the light sheet.

## Verification

Panes-reach-the-top change: see "Verification (panes reach the top)" at the end.

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

## Verification (panes reach the top)

* `make check` green: Go packages all ok, staticcheck clean, 46 vitest files / 647
  tests. `make gui-e2e` passes 238/238 (119 WebKit, 119 Chromium; `layout.spec.ts` 6 per browser).
* e2e: `layout.spec.ts` rewritten (sidebar band, gutter, window-top drag strip, pane and
  header geometry with the sidebar shown and hidden, the page headers, drag and no-drag
  per element). `panel.spec.ts` and `buttons.spec.ts` follow the 44px headers.
* Live (2026-10-09, macOS 27, `wails3 build` of this branch plus a temporary probe, an
  isolated `CODE_FOUNDRY_HOME` daemon, a scratch repo, and a terminal focused and the
  side panel opened through the CLI). Window screenshots (`screencapture -l`):
  * The traffic lights sit in the sidebar band's gutter. "REPOSITORIES", the count and
    both buttons are to their right, on the same line. The terminal and side panel
    headers share one top and bottom. Settings (search box, path, Reveal, ×) and Pull
    Requests render in the band the same way.
  * Sidebar hidden: the lights sit inside the terminal header's left padding. The title
    starts at x=89, past the lights.
  * A probe ran inside the real WKWebView. It wrapped the message handler, synthesised
    mouse events, and reported through the window title (read via CGWindowList).
    `drag.js` is loaded (`_wails.setResizable` present, OS `darwin`). A mouse-down then
    mouse-move on the sidebar band title, the gutter, the terminal header and title,
    the panel header and the window-top strip each sent `wails:drag`. A `dblclick`
    there sent `wails:drag:doubleclick`. On the new-terminal button, kill button, panel
    toggle, panel resize handle, terminal (xterm) and panel body, neither was sent. The
    same held for the terminal header and top strip with the sidebar hidden. Geometry:
    band 0–52, pane 8–772, terminal and panel headers 9–53.
* Not verified live: the window actually moving, zoom on double-click, a real click on
  a header button, and dragging the panel resize handle. This process has no
  Accessibility permission (`AXIsProcessTrusted()` false), so it cannot post real mouse
  events, and synthetic DOM events were kept from reaching the host. Those steps rely on
  Wails' own handling of `wails:drag`: `performWindowDragWithEvent` with the stored
  mouse-down.
