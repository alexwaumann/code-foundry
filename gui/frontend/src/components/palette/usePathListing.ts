import { useEffect, useState, type KeyboardEvent, type RefObject } from "react";
import { appInfo, pickDirectory } from "@/api/app";
import { OUTDATED_DAEMON_MESSAGE, isOutdatedDaemon } from "@/api/errors";
import { PathRejectedError, listDirectories, type DirectoryListingView } from "@/api/filesystem";
import { descendInto, tabCompletion, typedDir } from "@/palette/paths";

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

/**
 * Folder completion for a path typed into a cmdk input: the palette's `path` prompts and
 * the Add Project dialog's Local folder tab share it. The caller owns the input value
 * and renders <PathSuggestions> (pathCompletion.tsx) inside its cmdk list (rootRef is the cmdk root).
 *
 * Keys (handleKey, from the cmdk root's onKeyDown): Tab descends into the highlighted
 * folder, else extends to the common completion (asking right away when the debounced
 * listing is not for this input yet); `/` on a highlighted folder descends into it,
 * otherwise it is just typed.
 */
export function usePathCompletion(opts: {
  query: string;
  enabled: boolean;
  rootRef: RefObject<HTMLElement | null>;
  /** Replace the input with next, if it still reads from. */
  replace: (from: string, next: string) => void;
}): {
  paths: PathListingState | null;
  /** The Wails host answers: the native folder picker is available. */
  host: boolean;
  /** Handles Tab and `/`; true when the key was consumed. */
  handleKey: (e: KeyboardEvent) => boolean;
  /** The native folder picker, opened near the typed path; the chosen path or null. */
  chooseFolder: () => Promise<string | null>;
} {
  const { query, enabled, rootRef, replace } = opts;
  const paths = usePathListing(query, enabled);
  const host = useAppHost();

  /** Name of the highlighted folder suggestion (cmdk keeps the highlight in the DOM). */
  const highlightedEntry = (): string | null =>
    rootRef.current?.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute("data-entry-name") ?? null;

  const completePath = async () => {
    const q = query;
    const name = highlightedEntry();
    let completion = paths?.prefix === q ? (paths.listing?.completion ?? null) : null;
    if (name === null && completion === null) {
      try {
        completion = (await listDirectories(q)).completion;
      } catch {
        return;
      }
    }
    const next = tabCompletion(q, completion, name);
    if (next !== null) replace(q, next);
  };

  const handleKey = (e: KeyboardEvent): boolean => {
    if (!enabled) return false;
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      void completePath();
      return true;
    }
    if (e.key === "/") {
      const name = highlightedEntry();
      if (name !== null) {
        e.preventDefault();
        replace(query, descendInto(query, name));
        return true;
      }
    }
    return false;
  };

  const chooseFolder = async (): Promise<string | null> => {
    const picked = await pickDirectory(query);
    return picked || null;
  };

  return { paths, host, handleKey, chooseFolder };
}
