import { SHELL_GAP } from "@/design/tokens";

/**
 * Height in CSS px of a pane's header (PaneHeader, the side panel's PanelHeader, the
 * headerless panes' DragBand). The one source: those components set it as their height.
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
