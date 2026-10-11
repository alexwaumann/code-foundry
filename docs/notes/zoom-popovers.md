# Floating surfaces under page zoom

Bug: at any page zoom other than 100% (`appearance.zoom`, CSS `zoom` on `<html>`,
`ui-zoom.md`) every Radix floating surface (Popover, DropdownMenu, ContextMenu, Tooltip:
composer pickers, PR menus, sidebar row menus, thread tooltips) opened away from its
anchor: further down and right when zoomed in, up and left when zoomed out. Also: the
sidebar settings button now toggles the settings page, like the usage button.

## Mechanism (probe-verified, WebKit and Chromium)

Radix positions through floating-ui with `strategy: fixed`. floating-ui measures the
anchor, the floating element and the viewport with `getBoundingClientRect` /
`clientWidth`, which under the standardized zoom model are **viewport px**, and writes
`transform: translate(x, y)` on the popper wrapper (`[data-radix-popper-content-wrapper]`).
That wrapper is portaled into `<body>`, under the zoom on `<html>`, so the translate is
**layout px** and gets scaled again: every surface landed at `zoom × (x, y)`.

Probe, composer model picker at 125% (1280×800): trigger left/bottom 421/485, wrapper
`translate(421px, 491px)`, list drawn at 526.25/613.75 (= 421 × 1.25, 491 × 1.25). At
90% the list sat 47 px left of and above its trigger.
`zoom-popovers/before-model-picker-125-mock.png` is the mock app at 125% without the fix.

The same mismatch hit the lengths Radix exposes as CSS variables
(`--radix-popper-available-width/height`, `--radix-*-content-available-height`): viewport
px used as layout px inside zoomed content, so `max-h`/`max-w` caps were `zoom ×` too big.

## Fix

One CSS rule in `gui/frontend/src/index.css`, so it covers every Radix popper, not only
the shadcn wrappers:

```css
[data-radix-popper-content-wrapper] { zoom: calc(1 / var(--cf-zoom)); }
[data-radix-popper-content-wrapper] > * { zoom: var(--cf-zoom); }
```

Nested zooms multiply, so the wrapper is at effective zoom 1 (its translate is viewport
px, exactly what floating-ui computed) and the content is back at the page's zoom (same
size as everything around it). floating-ui now also measures the wrapper's size in
viewport px, so `align="end"`/`"center"`, flip and shift are consistent with the anchor.

Then, in the shared primitives (`components/ui/`):

- `max-h` from `--radix-*-content-available-height` (dropdown, context menu) and
  `POPUP_FIT` (`components/pr/keys.ts`, `--radix-popper-available-width`) divide by
  `--cf-zoom`.
- `sideOffset`, `alignOffset` and `collisionPadding` are viewport px to Radix; the
  primitives multiply them by the zoom (`useZoomFactor`/`zoomPx` in `lib/zoom.ts`) so a
  6 px gap is 7.5 screen px at 125%, like the rest of the page.

Not Radix, same class of bug: the Usage page chart tooltip put `clientX - rect.left`
(viewport px) into `left` (layout px). It now divides by the chart's rendered-to-layout
width ratio.

## Alternatives considered

- **Portal container that counter-zooms** (`<Portal container={el}>` with
  `zoom: 1/zoom`, content re-zoomed): the same arithmetic, but needs a container element
  and a `container` prop on every Portal, and misses any popper rendered without our
  wrappers. The attribute rule needs neither.
- **Dividing the translate**: Radix does not expose floating-ui middleware or the
  platform, so there is no hook to rewrite x/y; `collisionBoundary` changes only what is
  avoided, not the coordinate space.
- **Moving the zoom off `<html>` to `#root`** (portals in an unzoomed body): the content
  would then need its own zoom anyway, and every existing `--cf-zoom` viewport-unit fix
  would have to move with it.

## Verified

- e2e `gui/frontend/e2e/zoom-popovers.spec.ts` (WebKit + Chromium): model picker 6×zoom
  px under its trigger and left-aligned at 90/100/125/150%; flips above at 150% in a
  short window with the same gap; row context menu at the pointer at 125% and shifted
  up to stay inside the window near the bottom edge; thread tooltip 12×1.25 px right of
  its row; usage chart tooltip at the pointer. All but the 100% cases fail without the
  CSS rule.
- Live (`make gui-build`, isolated `CODE_FOUNDRY_HOME`): composer model picker at 90,
  100, 125, 150% dark and 100, 125% light, `zoom-popovers/*.png`.

## Gotchas

- **The zoom ladder starts at 90%** (`ZOOM_LEVELS`, the schema rejects 80); `setZoom(80)`
  silently clamps to 90, so a probe "at 80%" is really at 90%.
- `zoom: calc(1 / var(--cf-zoom))` works in WebKit and Chromium; `--cf-zoom` defaults
  to 1 on `:root`, so the rule is a no-op at 100%.
- Radix ContextMenu puts its menu 2 px right of the pointer with its own `sideOffset`,
  which the wrapper cannot pass through; it stays 2 viewport px at every zoom.
- Context menus do not flip vertically (side is right); near the bottom edge they shift
  up. Popovers and dropdowns flip to the top.
- Not fixed here, found by reading only (not a floating surface, not verified): the side
  panel's resize handle (`PanelResizeHandle.tsx`) starts a drag from
  `getBoundingClientRect().width` (viewport px) and adds pointer deltas (viewport px) to a
  layout-px width, so under zoom the panel likely jumps at drag start and tracks the
  pointer at `zoom ×` speed.

## Settings toggle

`showView("settings")` closes settings when it is already open (`closeSettings`, which
refocuses the selection's terminal), mirroring `"usage"`. The status-row button, cmd+,
and `code-foundry view.settings` all go through it; the button shows pressed while the
page is up. The command keeps its name and chord; its title is now "Settings" (was "Open
Settings") and its description says it closes the page where it already shows.
