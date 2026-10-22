import { useEffect, useRef, useState, type CSSProperties } from "react";
import { activeThemeSlots, onThemePublished, subscribeThemeSlots, themeFrameMessage, useActiveTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { isThemeAck, resizeHeight } from "./previewGrant";

/**
 * The frame's sandbox: scripts, forms, dialogs, downloads and popups (a target=_blank link
 * opens in the browser), but never `allow-same-origin`, so the page has an opaque origin
 * and cannot reach Code Foundry's window or the daemon's authenticated routes, and never
 * `allow-top-navigation`, so a link cannot replace the app.
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/**
 * How long a frame waits, after a new theme reached the daemon, for the page to answer
 * `cf:theme` with `{ type: "cf:theme:ack" }` before it reloads (docs/notes/inline-html-2-fixes.md).
 */
export const THEME_ACK_MS = 300;

/**
 * An HTML page in a sandboxed frame at a granted URL (usePreviewGrant). The File tab's
 * preview and a thread's inline page are this one frame (docs/notes/
 * html-preview-interactive.md, inline-html.md). A page that links `/cf/theme.css` paints in
 * the user's theme; the frame is also posted `{ type: "cf:theme", id, scheme, vars }` on
 * load and on every theme change (docs/notes/theme-css-route.md). The target is "*": the
 * frame is opaque-origin.
 *
 * Theme changes (inline-html-2-fixes.md):
 * - The iframe element's own `color-scheme` is the app's scheme, which WebKit hands the page
 *   as its `prefers-color-scheme` (live, without a reload), so a page with a
 *   `prefers-color-scheme` block follows the app, not macOS. Only the element's own value
 *   counts: the one it inherits from `<html>` does not.
 * - A page that applies `cf:theme` itself answers `{ type: "cf:theme:ack" }` and keeps its
 *   state. Once the daemon has a theme other than the one the frame loaded in
 *   (onThemePublished) and the page did not ack it, the frame is posted the theme again
 *   and reloads THEME_ACK_MS later unless an ack came meanwhile: a page that only links the
 *   stylesheet (fetched once, no-store) repaints, its state going with the reload.
 *
 * `onResize` hears this frame's own `{ type: "cf:resize", height }` messages (a page asking
 * for its height). A white canvas, as in a browser.
 */
export function HtmlFrame({
  url,
  name,
  className,
  style,
  onResize,
  testId,
}: {
  url: string;
  name: string;
  className?: string;
  style?: CSSProperties;
  onResize?: (height: number) => void;
  testId: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scheme = useActiveTheme().scheme;
  // The frame's load (its key): a reload is a new one.
  const [load, setLoad] = useState(0);
  // The slots the page shows: what it loaded in, or the last it acked.
  const shown = useRef(activeThemeSlots());
  // The slots of the last post, and the last ones the page acked.
  const posted = useRef<Readonly<Record<string, string>> | null>(null);
  const acked = useRef<Readonly<Record<string, string>> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const post = () => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    posted.current = activeThemeSlots();
    win.postMessage(themeFrameMessage(), "*");
  };
  const postRef = useRef(post);
  useEffect(() => {
    postRef.current = post;
  });
  useEffect(() => {
    const stopSlots = subscribeThemeSlots(() => {
      postRef.current();
    });
    const stopPublished = onThemePublished(() => {
      const slots = activeThemeSlots();
      if (shown.current === slots) return;
      if (acked.current === slots) {
        shown.current = slots;
        return;
      }
      postRef.current();
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const now = activeThemeSlots();
        if (acked.current === now) {
          shown.current = now;
          return;
        }
        shown.current = now;
        acked.current = null;
        setLoad((n) => n + 1);
      }, THEME_ACK_MS);
    });
    return () => {
      stopSlots();
      stopPublished();
      clearTimeout(timer.current);
    };
  }, []);
  const resizeRef = useRef(onResize);
  useEffect(() => {
    resizeRef.current = onResize;
  });
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      if (isThemeAck(e.data)) {
        acked.current = posted.current;
        return;
      }
      const h = resizeHeight(e.data);
      if (h !== null) resizeRef.current?.(h);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, []);
  return (
    <iframe
      key={load}
      ref={frameRef}
      onLoad={() => {
        post();
      }}
      aria-label={`${name} (rendered)`}
      src={url}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      className={cn("w-full border-0 bg-white", className)}
      style={{ ...style, colorScheme: scheme }}
      data-testid={testId}
      data-load={load}
    />
  );
}
