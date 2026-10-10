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

/** The last list this GUI saw: the picker shows it at once on the next opening. */
let lastOwners: PublishOwnerView[] | null = null;

/** Forgets the remembered list (tests). */
export function resetPublishOwnersCache(): void {
  lastOwners = null;
}

/**
 * The accounts the viewer can publish to (RepoService.ListPublishOwners), fetched while
 * enabled. The list rarely changes and takes a while to fetch (one GitHub request per
 * organization), so the picker always shows the latest known list right away: the one
 * this GUI saw last, then the daemon's cached one (allowStale), and when that is older
 * than the daemon's TTL a fresh one replaces it. Each list that arrives calls onOwners
 * with its first owner (the viewer) and its default visibility, and the list, so the
 * caller can keep its choice or fall back.
 */
export function usePublishOwners(enabled: boolean, onOwners: (first: PublishChoice, owners: PublishOwnerView[]) => void): OwnersState {
  const [state, setState] = useState<OwnersState>(() => (lastOwners ? { state: "ready", owners: lastOwners } : { state: "loading" }));
  const onOwnersRef = useRef(onOwners);
  useEffect(() => {
    onOwnersRef.current = onOwners;
  });
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    const aborted = () => ac.signal.aborted;
    const apply = (owners: PublishOwnerView[]) => {
      lastOwners = owners;
      setState({ state: "ready", owners });
      const first = owners[0];
      if (first) onOwnersRef.current({ owner: first.login, visibility: keepVisibility(null, first) }, owners);
    };
    const run = async () => {
      if (lastOwners) apply(lastOwners);
      try {
        const cached = await listPublishOwners({ allowStale: true }, undefined, ac.signal);
        if (aborted()) return;
        apply(cached.owners);
        if (!cached.stale) return;
        const fresh = await listPublishOwners({}, undefined, ac.signal);
        if (!aborted()) apply(fresh.owners);
      } catch (err) {
        // A known list stays on screen; the error only shows when there is nothing else.
        if (!aborted() && !lastOwners) setState({ state: "error", message: errorMessage(err) });
      }
    };
    void run();
    return () => {
      ac.abort();
    };
  }, [enabled]);
  return state;
}
