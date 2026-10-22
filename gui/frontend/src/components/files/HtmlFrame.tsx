import { useEffect, useRef, useState, type CSSProperties } from "react";
import { previewFile, type FilePreview } from "@/api/files";
import { errorMessage, isAbort } from "@/api/stream";
import { subscribeThemeSlots, themeFrameMessage } from "@/lib/theme";
import { cn } from "@/lib/utils";

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

/** A page's height request, `{ type: "cf:resize", height }` (CSS px, positive); null for any other message. */
export function resizeHeight(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; height?: unknown };
  if (m.type !== "cf:resize" || typeof m.height !== "number" || !Number.isFinite(m.height) || m.height <= 0) return null;
  return m.height;
}

/** A grant for one file: loading (no preview, no error yet), the grant, or why there is none. */
export interface PreviewGrant {
  preview: FilePreview | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

/**
 * Asks the daemon once per (baseDir, path) for a URL serving the file and what it may load
 * (FilesystemService.PreviewFile): `path` absolute, or relative to `baseDir`.
 */
export function usePreviewGrant(baseDir: string, path: string): PreviewGrant {
  const key = `${baseDir}\u0000${path}`;
  const [state, setState] = useState<{ key: string; preview: FilePreview | null; error: string | null }>({ key: "", preview: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    previewFile(baseDir, path, undefined, c.signal).then(
      (preview) => {
        if (!c.signal.aborted) setState({ key, preview, error: null });
      },
      (err: unknown) => {
        if (!isAbort(err) && !c.signal.aborted) setState({ key, preview: null, error: errorMessage(err) });
      },
    );
    return () => {
      c.abort();
    };
  }, [baseDir, path, key, attempt]);
  const current = state.key === key ? state : null;
  return {
    preview: current?.preview ?? null,
    error: current?.error ?? null,
    loading: current === null,
    retry: () => {
      setAttempt((n) => n + 1);
    },
  };
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
