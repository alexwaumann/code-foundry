import { useEffect, useState } from "react";
import { appInfo } from "@/api/app";
import { OUTDATED_DAEMON_MESSAGE, isOutdatedDaemon } from "@/api/errors";
import { PathRejectedError, listDirectories, type DirectoryListingView } from "@/api/filesystem";
import { typedDir } from "@/palette/paths";

/** Pause after a keystroke before asking the daemon. */
export const PATH_DEBOUNCE_MS = 100;

export interface PathListingState {
  /** The input this answers. */
  prefix: string;
  listing: DirectoryListingView | null;
  /** Shown instead of entries: a refused prefix or an outdated daemon. */
  message: string | null;
}

/** What to tell the user about a failed listing; null to stay quiet (no suggestions). */
export function listingMessage(err: unknown): string | null {
  if (err instanceof PathRejectedError) return err.message;
  if (isOutdatedDaemon(err)) return OUTDATED_DAEMON_MESSAGE;
  return null;
}

/**
 * Directory suggestions for a typed path, fetched ~100ms after the last keystroke. The
 * previous answer stays up while the next is in flight, but only while it lists the
 * same directory (its entries would name the wrong paths otherwise).
 */
export function usePathListing(query: string, enabled: boolean): PathListingState | null {
  const [state, setState] = useState<PathListingState | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      listDirectories(query, undefined, ac.signal).then(
        (listing) => {
          setState({ prefix: query, listing, message: null });
        },
        (err: unknown) => {
          if (!ac.signal.aborted) setState({ prefix: query, listing: null, message: listingMessage(err) });
        },
      );
    }, PATH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [query, enabled]);
  if (!enabled || !state || typedDir(state.prefix) !== typedDir(query)) return null;
  return state;
}

/** True once the Wails host answers (the native folder picker is available). */
export function useAppHost(): boolean {
  const [host, setHost] = useState(false);
  useEffect(() => {
    let live = true;
    void appInfo().then((info) => {
      if (live) setHost(info !== null);
    });
    return () => {
      live = false;
    };
  }, []);
  return host;
}
