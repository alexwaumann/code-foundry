/**
 * Height in CSS px of the window's title band. The window uses macOS's hidden-inset
 * title bar, so web content runs under the traffic lights. Hidden-inset (an empty
 * toolbar) puts the lights at x 19-79, y 19-33 pt, centred on y=26, so a 52 px band
 * centres them with 19 px above and below.
 *
 * Nothing spans the band. The sidebar's top band (the traffic-light gutter, then the
 * Repositories header) is this tall. The content pane and the side panel start 8 px
 * down (the gap they keep on every side), and their headers are 44 px (`h-11`,
 * PaneHeader), so every header ends on the band's bottom edge.
 *
 * The band is not a native drag region: gui/main.go sets InvisibleTitleBarHeight to 0.
 * The sidebar band and the pane headers drag the window through the Wails runtime
 * (`--wails-draggable: drag`). See docs/notes/phase3-ui-panes.md.
 */
export const TITLE_BAND_HEIGHT = 52;

/** Width of the traffic-light gutter at the window's left edge (the zoom button ends at x=79). */
export const TRAFFIC_LIGHT_GUTTER = 80;
