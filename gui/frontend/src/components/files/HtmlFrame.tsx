import { useEffect, useRef, type CSSProperties } from "react";
import { subscribeThemeSlots, themeFrameMessage } from "@/lib/theme";
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
 * frame is opaque-origin. `onResize` hears this frame's own `{ type: "cf:resize", height }`
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
