/**
 * Height in CSS px of the strip across the top of the window. The window uses macOS's
 * hidden-inset title bar, so web content runs under the traffic lights; this strip is
 * the title bar's stand-in. Hidden-inset (an empty toolbar) puts the lights at x 19-79,
 * y 19-33 pt, centred on y=26, so a 52 px strip centres them with 19 px above and below.
 * Keep in sync with `titleStripHeight` in gui/main.go (InvisibleTitleBarHeight), which
 * makes the same band drag the window natively.
 */
export const TITLE_STRIP_HEIGHT = 52;

/** Width of the traffic-light gutter at the strip's left end (lights end at x=79). */
export const TRAFFIC_LIGHT_GUTTER = 80;

/**
 * Draggable band across the full window width, sitting on the sheet. Nothing interactive
 * lives here: the native invisible title bar drags on every mouse-down in this band, so a
 * button inside it would start a window drag instead of a click. `--wails-draggable: drag`
 * gives the same drag (and double-click to zoom) to the Wails runtime in the webview.
 */
export function TitleStrip() {
  return (
    <div className="flex shrink-0 [--wails-draggable:drag]" style={{ height: TITLE_STRIP_HEIGHT }} data-testid="title-strip" aria-hidden>
      <div className="shrink-0" style={{ width: TRAFFIC_LIGHT_GUTTER }} data-testid="traffic-light-gutter" />
    </div>
  );
}
