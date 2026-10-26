import { useEffect, useState } from "react";
import { previewFile, type FilePreview } from "@/api/files";
import { errorMessage, isAbort } from "@/api/stream";
import { useHealthStore } from "@/stores/health";

/** A page's height request, `{ type: "cf:resize", height }` (CSS px, positive); null for any other message. */
export function resizeHeight(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; height?: unknown };
  if (m.type !== "cf:resize" || typeof m.height !== "number" || !Number.isFinite(m.height) || m.height <= 0) return null;
  return m.height;
}

/**
 * The key a page's bridge forwards, `{ type: "cf:key", key: "Escape" }`: Escape pressed in the
 * page that nothing there consumed (docs/notes/page-library-fixes-b.md); null for any other message.
 */
export function pageKey(data: unknown): "Escape" | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; key?: unknown };
  return m.type === "cf:key" && m.key === "Escape" ? "Escape" : null;
}

/** A page's answer to `cf:theme`, `{ type: "cf:theme:ack" }`: it applied the theme itself, so its frame need not reload. */
export function isThemeAck(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === "cf:theme:ack";
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
 * (FilesystemService.PreviewFile): `path` absolute, or relative to `baseDir`. Again when the
 * daemon restarts (its pid changes): grants die with it, and a frame reloading on a dead one
 * (a theme switch, an edit) would come back blank. The last grant stays until the new one
 * arrives, so a frame that is up does not flash.
 */
export function usePreviewGrant(baseDir: string, path: string): PreviewGrant {
  const key = `${baseDir}\u0000${path}`;
  const [state, setState] = useState<{ key: string; preview: FilePreview | null; error: string | null }>({ key: "", preview: null, error: null });
  const [attempt, setAttempt] = useState(0);
  // A new daemon (another pid; not the same one back after a blip) asks again.
  const daemon = useHealthStore((s) => (s.status === "ok" ? (s.health?.pid ?? null) : null));
  const [epoch, setEpoch] = useState({ pid: daemon, n: 0 });
  if (daemon !== null && daemon !== epoch.pid) setEpoch({ pid: daemon, n: epoch.n + 1 });
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
  }, [baseDir, path, key, attempt, epoch.n]);
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
