import { useEffect, useRef, useState, type CSSProperties } from "react";
import { activeThemeSlots, onThemePublished, subscribeThemeSlots, themeFrameMessage } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { resizeHeight } from "./previewGrant";

/**
 * The frame's sandbox: scripts, forms, dialogs, downloads and popups (a target=_blank link
 * opens in the browser), but never `allow-same-origin`, so the page has an opaque origin
 * and cannot reach Code Foundry's window or the daemon's authenticated routes, and never
 * `allow-top-navigation`, so a link cannot replace the app.
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/** Posts the active theme to a preview frame (it ignores the message unless it listens). */
function postTheme(frame: HTMLIFrameElement | null): void {
  frame?.contentWindow?.postMessage(themeFrameMessage(), "*");
}

/**
 * An HTML page in a sandboxed frame at a granted URL (usePreviewGrant). The File tab's
 * preview and a thread's inline page are this one frame (docs/notes/
 * html-preview-interactive.md, inline-html.md). A page that links `/cf/theme.css` paints in
 * the user's theme; the frame is also posted `{ type: "cf:theme", id, scheme, vars }` on
 * load and on every theme change (docs/notes/theme-css-route.md). The target is "*": the
 * frame is opaque-origin. Once the daemon has a theme other than the one the frame loaded in
 * (onThemePublished), the frame reloads, so a page that only links the stylesheet (it is
 * fetched once, no-store) repaints too; the page's own state goes with it. `onResize` hears this frame's own `{ type: "cf:resize", height }`
 * messages (a page asking for its height). A white canvas, as in a browser.
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
  useEffect(
    () =>
      subscribeThemeSlots(() => {
        postTheme(frameRef.current);
      }),
    [],
  );
  // The theme the frame loaded in; a newer one published reloads it (a new key).
  const [load, setLoad] = useState(() => ({ n: 0, slots: activeThemeSlots() }));
  useEffect(
    () =>
      onThemePublished(() => {
        const slots = activeThemeSlots();
        setLoad((l) => (l.slots === slots ? l : { n: l.n + 1, slots }));
      }),
    [],
  );
  const resizeRef = useRef(onResize);
  useEffect(() => {
    resizeRef.current = onResize;
  });
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
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
      key={load.n}
      ref={frameRef}
      onLoad={() => {
        postTheme(frameRef.current);
      }}
      aria-label={`${name} (rendered)`}
      src={url}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      className={cn("w-full border-0 bg-white", className)}
      style={style}
      data-testid={testId}
    />
  );
}
