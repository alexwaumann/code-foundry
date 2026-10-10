import { useEffect, useRef, useState } from "react";
import { listPublishOwners } from "@/api/publish";
import { errorMessage } from "@/api/stream";
import { keepVisibility, type PublishOwnerView, type Visibility } from "@/lib/publish";

/** The publish picker's choice: where, and how visible. */
export interface PublishChoice {
  owner: string;
  /** null until an owner is picked, or when no default applies (never Private). */
  visibility: Visibility | null;
}

export type OwnersState = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; owners: PublishOwnerView[] };

/**
 * The accounts the viewer can publish to (RepoService.ListPublishOwners; the daemon caches
 * them for 10 minutes), fetched while enabled. Once they arrive, onFirst gets the first
 * owner (the viewer) with its default visibility.
 */
export function usePublishOwners(enabled: boolean, onFirst: (choice: PublishChoice) => void): OwnersState {
  const [state, setState] = useState<OwnersState>({ state: "loading" });
  const onFirstRef = useRef(onFirst);
  useEffect(() => {
    onFirstRef.current = onFirst;
  });
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    listPublishOwners(undefined, ac.signal)
      .then((owners) => {
        if (ac.signal.aborted) return;
        setState({ state: "ready", owners });
        const first = owners[0];
        if (first) onFirstRef.current({ owner: first.login, visibility: keepVisibility(null, first) });
      })
      .catch((err: unknown) => {
        if (!ac.signal.aborted) setState({ state: "error", message: errorMessage(err) });
      });
    return () => {
      ac.abort();
    };
  }, [enabled]);
  return state;
}
