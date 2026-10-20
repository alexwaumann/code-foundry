# Design system 2: the shell on `--gap-shell` and `rounded-pane`

PR 2 of 4 of the design-system normalization (1: tokens + guard, #126; 2: this; 3 and 4:
sweep src onto the type roles and the radius scale). It moves the shell's seams onto the
tokens PR 1 added, re-centres the title band on the pane headers, and puts the sidebar's
edge icons on the gutter line.

## Geometry

| | before | now | source |
| --- | --- | --- | --- |
| shell gap (window edges, between panes, sidebar body inset, window-top drag strip) | 8 | 12 | `--gap-shell` (`m-shell`, `mt-shell`, `pl-shell`, `h-shell`); `SHELL_GAP` in `src/design/tokens.ts` for arithmetic |
| `PANE_GAPS` (panelMax: sidebar \| gap \| content \| gap \| panel \| gap) | 24 | 36 | `3 * SHELL_GAP` (stores/ui.ts) |
| `BOTTOM_GAP` (content pane to bottom panel) | 8 | 12 | `SHELL_GAP` |
| pane header | 44 | 44 | `PANE_HEADER_HEIGHT` (titleBand.ts), set as `height` by PaneHeader, the side panel's PanelHeader and DragBand (no more `h-11`) |
| title band | 52 | 56 = 12 + 44 | `TITLE_BAND_HEIGHT = SHELL_GAP + PANE_HEADER_HEIGHT` |
| band content centre (app name, traffic lights) | 26 (band middle) | 34 = 12 + 44 / 2 | `TITLE_BAND_CENTER`; Go `buttonCenterY` |
| pane corner (content, side, bottom panes; dialogs) | `rounded-lg` 10 | `rounded-pane` 12 | `--radius` |

`roles.test.ts` fails when `SHELL_GAP` and `--gap-shell` differ; `ui.test.ts` asserts
`PANE_GAPS = 3 * SHELL_GAP = 36`; `PaneHeader.test.tsx` pins 44/56/34;
`trafficlights_darwin_test.go` pins `buttonCenterY` at 90/100/125/150/200%.

## Why the traffic lights moved

Before, the band was 52 and everything in it centred at 26, but the pane headers start a
gap down (8 + 44), so their text centred at 30-31: the lights and the app name sat ~5px
above the headers beside them (accepted in phase3-ui-panes.md). With a 12px gap that
would have grown to 6px, so the band now centres on the header instead: the sidebar band
pads the app name's header by `pt-shell`, so it centres in the lower 44px, and
`gui/trafficlights_darwin.go` puts the lights at `(shellGap + paneHeaderHeight / 2) *
zoom` = 34 points at 100% (was `52 * zoom / 2`). Go keeps its own `shellGap = 12` and
`paneHeaderHeight = 44` with a comment naming titleBand.ts; there is no cross-language
check. The gutter width (80 screen px) is unchanged. The band still drags.

## Edge icon buttons

The sidebar's icon buttons are `icon-xs`: a 24px box (`size-6`) around a 14px glyph
(`size-3.5`), so the glyph sat 5px inside the row edge. The toolbar's first button
(Dashboard) takes `-ml-1.25` and the status row's last (Settings) `-mr-1.25`, so their
glyph boxes land on the sidebar's left gutter line (x = 12, where New thread and the rows
start) and on its right edge (12px from the pane). Their hover and pressed backgrounds
still show the whole box, 5px past the line. Lucide draws a 24-unit viewBox with ~2 units
of padding, so the ink itself is ~1px further in (measured: Dashboard ink from x=13,
Settings ink to 219 of 220).

The same rule vertically (2026-10-19): the status row (`h-6`) ends 7px above the window's
bottom edge (`pb-1.75`, was 6px), so its glyph boxes end on the content pane's bottom edge
(12px up, `m-shell`). The row's text (a status dot and the daemon version; the daemon's
pid and uptime moved into the dot's tooltip) is centred in the row, its ink 2-3px above
the line. Before, the glyphs and text straddled the pane's bottom edge.

Also checked:

- Footer section headers (Working/Snoozed/Archived): the chevron sat in the header button's
  `px-2`, 8px inside the edge, visibly off the Settings line just below it. It now takes
  `-mr-2`, so its box ends on the sidebar edge (e2e asserts it).
- Thread rows' trailing chips (pin, workspace and linked-PR badges, archived age, snooze
  time): left as they are, 8px inside the row box. They are row content, symmetric with the
  name's 8px left inset, and filled badges pulled to the box edge would touch the selected
  row's background edge. The row boxes themselves are on the gutter lines.

## Resize handles

The side and bottom panels' handles filled the 8px gap (`-left-2 w-2`, `-top-2 h-2`); they
now fill the 12px one (`-left-shell w-shell`, `-top-shell h-shell`), hairline in the middle.
The sidebar's handle straddled its right edge (`-right-1 w-2`); with Settings now reaching
that edge it would have covered the glyph's last 4px, so it moved into the gap too
(`-right-shell w-shell`), like the other two.

## Live check (gui/bin, isolated CODE_FOUNDRY_HOME, Projects page with its side panel)

Measured from `screencapture -R` window shots (device scale 2) in window points: the red
light's vertical extent, the app name's "C" ink (cap centre), and the pane header's content
box (pane top border to header bottom border) down one column.

| zoom | traffic lights | app name (cap) | pane header content |
| --- | --- | --- | --- |
| 90% dark | 30.5 | 30.0 | 30.0 |
| 100% dark | 34.0 | 33.5 | 33.5 |
| 125% dark | 42.5 | 42.0 | 42.0 |
| 150% dark | 51.0 | 50.5 | 50.75 |
| 100% light | 34.0 | 33.5 | 33.5 |

All three coincide within 0.5pt at every zoom. Sidebar corners at 100%: New thread spans
x 12-220, the Dashboard glyph box starts at 12, the Settings glyph ends at 220 (ink 219),
the content pane starts at 232.

## Gotchas

- **The web content sits 1pt above the window's top edge** in the live app: the pane's top
  border is at window y 11 where the DOM says 12, while the bottom and left gaps measure
  12 (so the page is laid out a point taller than the window and offset up; cause not
  dug into). Constant across zooms and independent of this PR. It is why the lights (native, placed in window coordinates) read
  0.5pt below the web content; the DOM in Playwright has the name's centre at exactly 34.
- The header's content centres at 34.5 in the DOM, not 34: the pane's 1px top border is
  above it and its own 1px bottom border is inside its 44px. The band uses 12 + 22 as
  decided; the half pixel is one device pixel at 2x.
- Before the frontend's first `SetZoom` the lights are at hidden-inset's default (y 26);
  the window is shown only after the page paints, and `applyZoom` calls the host on start,
  so no jump was seen at launch.
- Tailwind v4 takes quarter steps of `--spacing`, so the 5px pull is `-ml-1.25` /
  `-mr-1.25`, no arbitrary value.
- `UpdateDialog` overrides its content to `rounded-[10px]`; left for the radius sweep
  (PR 3/4), as this PR changes no other radius.
- The isolated copy shares the installed app's WebKit localStorage: zoom and `cf.theme`
  (the isolated daemon's `appearance.theme` default, `system`, overwrote `dark`) were put
  back before quitting.

## Verified

- `make check` green.
- `make gui-e2e` (`E2E_MOCK_PORT=7833 E2E_VITE_PORT=9288`; 7799/9255 were taken): 806
  passed, 40 skipped, 4 failed: the two panel-drag tests per browser still expected the
  24px gaps' widths. Fixed, then panel, layout, bottom-panel, sidebar, snooze and archive
  specs re-run: 170 passed, 8 skipped. layout, panel and bottom-panel specs follow the
  12px gap, the 56px band, the 34px centre and the edge glyphs.
- The live check ran on the build before the chevron change; the chevrons were checked
  in the mock-daemon shots and by e2e.
- Playwright WebKit against the mock daemon, dark and light: band 56, pane top 12, header
  13-57, app name centre 34.
