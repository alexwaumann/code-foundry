import { useCallback, useEffect, useState } from "react";
import { streamFile } from "@/api/files";
import { errorMessage, isAbort } from "@/api/stream";
import { useHealthStore } from "@/stores/health";

/** A URL the player can stream the file from (FilesystemService.StreamFile), or why there is none. */
export interface MediaGrant {
  /** The URL for `<video src>` / `<audio src>`; null until the first answer, and after a refusal. */
  url: string | null;
  /** Why the daemon gave no URL (the file went, macOS privacy, an older daemon). */
  error: string | null;
  /** Counts answers: a new one (even the same URL again) is a reason to load the element again. */
  generation: number;
  /** Asks again: the element failed on the URL it had (a daemon restart makes it 404). */
  regrant: () => void;
}

/**
 * Asks the daemon for a stream URL for `path` (absolute, or relative to `baseDir`) once per
 * path and `version`, again on `regrant()`, and again when the daemon restarts (its pid
 * changes): a grant dies with the daemon that minted it. The last URL stays until the next
 * answer, so the element is not emptied in between. Never reads the bytes itself.
 */
export function useMediaGrant(baseDir: string, path: string, version: string): MediaGrant {
  const key = `${baseDir}\u0000${path}`;
  const [state, setState] = useState<{ key: string; url: string | null; error: string | null; generation: number }>({ key: "", url: null, error: null, generation: 0 });
  const [asks, setAsks] = useState(0);
  // A new daemon (another pid; not the same one back after a blip) asks again.
  const daemon = useHealthStore((s) => (s.status === "ok" ? (s.health?.pid ?? null) : null));
  const [epoch, setEpoch] = useState({ pid: daemon, n: 0 });
  if (daemon !== null && daemon !== epoch.pid) setEpoch({ pid: daemon, n: epoch.n + 1 });
  useEffect(() => {
    const c = new AbortController();
    streamFile(baseDir, path, undefined, c.signal).then(
      (s) => {
        if (!c.signal.aborted) setState((prev) => ({ key, url: s.url, error: null, generation: prev.generation + 1 }));
      },
      (err: unknown) => {
        if (!isAbort(err) && !c.signal.aborted) setState((prev) => ({ key, url: null, error: errorMessage(err), generation: prev.generation + 1 }));
      },
    );
    return () => {
      c.abort();
    };
  }, [baseDir, path, key, version, asks, epoch.n]);
  const regrant = useCallback(() => {
    setAsks((n) => n + 1);
  }, []);
  const current = state.key === key ? state : null;
  return { url: current?.url ?? null, error: current?.error ?? null, generation: current?.generation ?? 0, regrant };
}
