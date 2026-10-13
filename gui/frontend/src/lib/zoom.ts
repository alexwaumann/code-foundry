/**
 * Page zoom: cmd+= / cmd+- / cmd+0 scale the whole window, like a browser or T3 Code
 * (Electron's zoom level), not just the terminal font. The zoom is CSS `zoom` on <html>,
 * which WebKit lays out at the scaled size (rects and events stay in viewport px, the
 * standardized zoom model), so every px and rem value grows with it. Two things do not:
 * viewport units (100vh is still the whole window, so zoomed it overflows; the app root
 * uses a 100% height chain and the few vh offsets divide by --cf-zoom, index.css), and
 * canvas backing stores (a terminal host undoes the zoom on itself and scales the
 * font instead, components/terminal/TerminalHost.tsx). The native traffic lights are
 * outside the page: the Wails host re-centres them on the zoomed band (api/app.ts
 * setHostZoom, gui/trafficlights_darwin.go). Radix floating surfaces position themselves in
 * viewport px: their wrapper undoes the zoom and their content zooms back (index.css,
 * docs/notes/zoom-popovers.md).
 */
import { setHostZoom } from "@/api/app";
import { useUiStore } from "@/stores/ui";

export function applyZoom(percent: number): void {
  const factor = percent / 100;
  const root = document.documentElement;
  root.style.zoom = factor === 1 ? "" : String(factor);
  root.style.setProperty("--cf-zoom", String(factor));
  root.dataset.zoom = String(percent);
  // The traffic lights are native and outside the zoom; the host re-centres them.
  void setHostZoom(percent);
}

/**
 * The page zoom factor (1 at 100%): divide a viewport-px distance (getBoundingClientRect,
 * innerHeight) by it to get layout px, the unit of the CSS values set on zoomed elements.
 */
export function zoomFactor(): number {
  const factor = parseFloat(document.documentElement.style.getPropertyValue("--cf-zoom"));
  return factor > 0 ? factor : 1;
}

/**
 * The window's width in layout px: viewport px divided by the zoom. The body's box is
 * laid out under the zoom (the root's clientWidth stays in viewport px in WebKit).
 */
export function layoutWidth(): number {
  return document.body.clientWidth || window.innerWidth;
}

/**
 * The zoom factor (1.25 at 125%). Radix popper offsets and collision padding are in
 * viewport px (floating-ui measures with getBoundingClientRect), so the ui primitives
 * multiply them by this to keep the gaps proportional to the zoomed page.
 */
export function useZoomFactor(): number {
  return useUiStore((s) => s.zoom) / 100;
}

/** Scales a Radix offset or collision padding (a number or per-side object) by the zoom factor. */
export function zoomPx<T extends number | Partial<Record<"top" | "right" | "bottom" | "left", number>> | undefined>(value: T, factor: number): T {
  if (value === undefined || factor === 1) return value;
  if (typeof value === "number") return (value * factor) as T;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v * factor])) as T;
}

/** Keeps <html> zoomed to the store's value; onChange runs after each change (the layout width moved). */
export function startZoomSync(onChange?: () => void): () => void {
  let last = useUiStore.getState().zoom;
  applyZoom(last);
  return useUiStore.subscribe((s) => {
    if (s.zoom === last) return;
    last = s.zoom;
    applyZoom(s.zoom);
    onChange?.();
  });
}
