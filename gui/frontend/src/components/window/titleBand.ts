import { SHELL_GAP } from "@/design/tokens";

/**
 * Height in CSS px of a pane's header (PaneHeader, a pane's tab strip,
 * the headerless panes' DragBand, a sheet's SheetHeader). The one source: those components
 * set it as their height.
 */
export const PANE_HEADER_HEIGHT = 44;

/**
 * Height in CSS px of the window's title band: the shell gap (the panes start that far
 * down, as they keep it on every side) plus a pane header, 12 + 44 = 56. Nothing spans
 * the band. The sidebar's top band (the traffic-light gutter, then the app name) is this
 * tall, and every pane header ends on its bottom edge.
 *
 * The window uses macOS's hidden-inset title bar, so web content runs under the traffic
 * lights. The band's content centres on the pane headers, TITLE_BAND_CENTER below the
 * top, not on the band: the sidebar band pads its top by the gap, and the host moves the
 * lights there (gui/trafficlights_darwin.go; hidden-inset alone puts them at y=26).
 *
 * The band is not a native drag region: gui/main.go sets InvisibleTitleBarHeight to 0.
 * The sidebar band and the pane headers drag the window through the Wails runtime
 * (`--wails-draggable: drag`). See docs/notes/phase3-ui-panes.md and
 * docs/notes/design-system-2-shell.md.
 */
export const TITLE_BAND_HEIGHT = SHELL_GAP + PANE_HEADER_HEIGHT;

/**
 * Where the band's content centres, in CSS px below the window top: the pane header's
 * middle, 12 + 22 = 34. gui/trafficlights_darwin.go centres the lights on it (times the
 * zoom) from its own copies of the gap and the header height.
 */
export const TITLE_BAND_CENTER = SHELL_GAP + PANE_HEADER_HEIGHT / 2;

/** Width of the traffic-light gutter at the window's left edge (the zoom button ends at x=79). */
export const TRAFFIC_LIGHT_GUTTER = 80;

/**
 * The gutter in layout px at a page zoom (percent, stores/ui.ts). The lights are native
 * and do not zoom with the page (lib/zoom.ts), so the gutter is kept at 80 screen px:
 * narrower in layout px when zoomed in, wider when zoomed out. The band's height does
 * zoom (like T3 Code's top bar), and the host moves the lights to its zoomed centre.
 */
export function trafficLightGutter(zoom: number): number {
  return Math.round((TRAFFIC_LIGHT_GUTTER * 100) / zoom);
}

/**
 * The top bar's leading run after the traffic-light gutter, in CSS px (components/shell/TopBar.tsx
 * draws it with these): its left padding (pl-3), the app name's box, the bar's gap (gap-1) and the
 * toggle's margin (ml-2) before the sidebar toggle, and the toggle itself (size-7). The app name's
 * box is fixed at its text's width in WebKit (17px semibold "Code Foundry": 107.1px, rounded up),
 * so the toggle's right edge is a constant.
 */
export const TOP_BAR_PAD_LEFT = 12;
export const APP_NAME_WIDTH = 108;
export const TOGGLE_GAP = 4 + 8;
export const TOGGLE_SIZE = 28;

/**
 * Where the sidebar toggle's right edge sits, in layout px from the window's left, at a page zoom
 * (percent): 80 + 12 + 108 + 12 + 28 = 240 at 100%. The sidebar's minimum and default width line
 * its right edge up with it (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-25f-sizes.md).
 */
export function sidebarToggleEnd(zoom: number): number {
  return trafficLightGutter(zoom) + TOP_BAR_PAD_LEFT + APP_NAME_WIDTH + TOGGLE_GAP + TOGGLE_SIZE;
}
