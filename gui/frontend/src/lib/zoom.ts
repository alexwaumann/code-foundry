/**
 * Page zoom: cmd+= / cmd+- / cmd+0 scale the whole window, like a browser or T3 Code
 * (Electron's zoom level), not just the terminal font. The zoom is the webview's own page
 * zoom, set by the Wails host (api/app.ts setHostZoom, gui/app.go SetZoom): the page lays
 * out again at the new size in one coordinate system, as under a browser's zoom, so
 * nothing in the page compensates for it. A CSS px is `zoom` points on screen, and
 * devicePixelRatio is multiplied by the zoom, so a canvas sized from it stays sharp.
 *
 * Two things live outside the page. The native traffic lights: the host re-centres them
 * on the zoomed title band (gui/trafficlights_darwin.go, components/window/titleBand.ts).
 * A file dragged in from the OS: its position arrives in points (api/app.ts).
 *
 * Without a host (the browser dev frontend, the e2e suite) there is no app zoom: the
 * browser's own zoom does the same. docs/notes/native-zoom.md.
 */
import { setHostZoom } from "@/api/app";
import { useUiStore } from "@/stores/ui";

export function applyZoom(percent: number): void {
  document.documentElement.dataset.zoom = String(percent);
  void setHostZoom(percent);
}

/** Keeps the window zoomed to the store's value; onChange runs after each change (the layout width moved). */
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
