import { useEffect, useState } from "react";
import { previewFile, type FilePreview } from "@/api/files";
import { errorMessage, isAbort } from "@/api/stream";

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
