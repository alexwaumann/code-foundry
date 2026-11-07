import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { resizeBrowser, watchBrowser, type BrowserEventView, type BrowserFrameView } from "@/api/browser";
import { isPageVisible, onVisibilityChange, runStream } from "@/api/stream";
import { browserAnswered, browserLeft, setBrowserOffline, setBrowserState, takeBrowserAddress } from "@/stores/browser";

/** How long a resize settles before the page reflows: a drag sends its last size, not each. */
const RESIZE_SETTLE_MS = 120;

/**
 * Draws the newest frame only: one decodes at a time, and what arrives meanwhile replaces what
 * was waiting. The stream's reader is never held up, so the daemon's window never fills on a
 * page that is merely slow to paint.
 */
export function newPainter(canvas: HTMLCanvasElement, decode: (jpeg: Uint8Array) => Promise<ImageBitmap> = decodeJpeg): (f: BrowserFrameView) => void {
  const ctx = canvas.getContext("2d");
  let busy = false;
  let waiting: BrowserFrameView | null = null;
  const draw = async (f: BrowserFrameView) => {
    busy = true;
    try {
      const image = await decode(f.jpeg);
      if (canvas.width !== image.width || canvas.height !== image.height) {
        canvas.width = image.width;
        canvas.height = image.height;
      }
      ctx?.drawImage(image, 0, 0);
      image.close();
    } catch {
      // A frame that does not decode is skipped; the next one replaces it.
    }
    busy = false;
    const next = waiting;
    waiting = null;
    if (next) void draw(next);
  };
  return (f) => {
    if (busy) waiting = f;
    else void draw(f);
  };
}

function decodeJpeg(jpeg: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
}

function usePageVisible(): boolean {
  return useSyncExternalStore((cb) => onVisibilityChange(cb), isPageVisible);
}

export interface PageSize {
  width: number;
  height: number;
}

/** The view's size in whole CSS pixels, kept current; zero while it has none. */
function useBoxSize(box: RefObject<HTMLElement | null>): PageSize {
  const [size, setSize] = useState<PageSize>({ width: 0, height: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      const width = Math.round(el.clientWidth);
      const height = Math.round(el.clientHeight);
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [box]);
  return size;
}

/**
 * Holds one BrowserService.Watch while the view can be seen: mounted, the window visible and
 * the view with a size. Out of those there is no stream, and with it the daemon's screencast
 * stops. Returns the page's size for input coordinates, read per event, and the view's scale
 * over the page, for what is drawn over it.
 */
export function useBrowserStream(
  surface: string,
  box: RefObject<HTMLElement | null>,
  canvas: RefObject<HTMLCanvasElement | null>,
): { page: RefObject<PageSize>; scale: { x: number; y: number } } {
  const visible = usePageVisible();
  const size = useBoxSize(box);
  const page = useRef<PageSize>({ width: 0, height: 0 });
  const [shown, setShown] = useState<PageSize>({ width: 0, height: 0 });
  const sent = useRef<PageSize>({ width: 0, height: 0 });
  const shows = visible && size.width > 0 && size.height > 0;

  useEffect(() => {
    if (!shows || !canvas.current) return;
    const paint = newPainter(canvas.current);
    const stop = runStream<BrowserEventView>({
      open: (signal) => {
        const { width, height } = sent.current.width > 0 ? sent.current : size;
        sent.current = { width, height };
        return watchBrowser({ surface, width, height, url: takeBrowserAddress(surface) }, signal);
      },
      onEvent: (ev) => {
        if (ev.kind === "state") {
          setBrowserState(surface, ev.state);
          browserAnswered(surface);
          return;
        }
        page.current = { width: ev.frame.width, height: ev.frame.height };
        // Only a new size renders: this runs for every frame.
        setShown((p) => (p.width === ev.frame.width && p.height === ev.frame.height ? p : page.current));
        paint(ev.frame);
      },
      onStatus: (status) => {
        setBrowserOffline(surface, status === "retrying");
        if (status === "retrying") browserLeft(surface);
      },
    });
    return () => {
      stop();
      browserLeft(surface);
    };
    // The size goes through Resize below; it must not reopen the stream.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, shows, canvas]);

  useEffect(() => {
    if (!shows || (size.width === sent.current.width && size.height === sent.current.height)) return;
    const t = setTimeout(() => {
      sent.current = size;
      resizeBrowser(surface, size.width, size.height).catch(() => undefined);
    }, RESIZE_SETTLE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [surface, shows, size]);

  return { page, scale: shown.width > 0 && shown.height > 0 ? { x: size.width / shown.width, y: size.height / shown.height } : { x: 1, y: 1 } };
}
