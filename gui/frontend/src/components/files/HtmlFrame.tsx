import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createBridgeHost, type BridgeHost } from "@/stores/bridgeHost";
import { activeThemeSlots, onThemePublished, subscribeThemeSlots, themeFrameMessage, useActiveTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { isThemeAck, resizeHeight } from "./previewGrant";

/**
 * The frame's sandbox: scripts, forms, dialogs, downloads and popups (a target=_blank link
 * opens in the browser), and `allow-same-origin`, so a page keeps its localStorage and
 * IndexedDB (docs/notes/bridge-2-gui.md). That origin is the daemon's pages listener
 * (`/preview/` and `/cf/` on a port of their own), never the app's and never the API's,
 * whose CORS refuses it: the page still cannot reach Code Foundry's window or the
 * daemon's authenticated routes, and reaches Code Foundry only through the bridge. Never
 * `allow-top-navigation`, so a link cannot replace the app.
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

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
 * load and on every theme change (docs/notes/theme-css-route.md), to "*" as before the
 * bridge (a page holds nothing secret in it).
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
 *
 * The bridge (stores/bridgeHost.ts): a page loading `/cf/bridge.js` runs verbs and
 * subscribes to the app's state as `thread`, the thread that shows it; without one (a File
 * tab on any other HTML file) it gets a bridge that refuses every call. Only this frame's
 * own window, at the origin its URL names, is heard; replies go to that window and origin.
 */
export function HtmlFrame({
  url,
  name,
  className,
  style,
  onResize,
  testId,
  thread = null,
}: {
  url: string;
  name: string;
  /** The thread that shows the page, whose verbs and state its bridge may use; null for none. */
  thread?: string | null;
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
  // The bridge's host for this frame: one per owning thread and page; gone on unmount.
  const origin = useMemo(() => originOf(url), [url]);
  const host = useRef<BridgeHost | null>(null);
  const hasLoaded = useRef(false);
  useEffect(() => {
    const h = createBridgeHost({
      threadId: thread,
      pageName: name,
      post: (msg) => {
        const win = frameRef.current?.contentWindow;
        if (win && origin) win.postMessage(msg, origin);
      },
    });
    host.current = h;
    // A page already up (its thread was learnt after it loaded) hears a new ready now.
    if (hasLoaded.current) h.loaded();
    return () => {
      h.dispose();
      if (host.current === h) host.current = null;
    };
  }, [thread, name, origin]);
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
      if (h !== null) {
        resizeRef.current?.(h);
        return;
      }
      if (origin && e.origin === origin) host.current?.receive(e.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [origin]);
  return (
    <iframe
      key={load}
      ref={frameRef}
      onLoad={() => {
        post();
        hasLoaded.current = true;
        host.current?.loaded();
      }}
      aria-label={`${name} (rendered)`}
      src={url}
      sandbox={HTML_PREVIEW_SANDBOX}
      allow="clipboard-write"
      referrerPolicy="no-referrer"
      className={cn("w-full border-0 bg-white", className)}
      style={{ ...style, colorScheme: scheme }}
      data-testid={testId}
      data-load={load}
    />
  );
}

/** The origin a frame URL names; null for one that does not parse. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
