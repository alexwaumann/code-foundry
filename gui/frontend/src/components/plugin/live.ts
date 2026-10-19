/**
 * When a plugin's thread or terminal node holds a live stream
 * (docs/notes/plugins-12-renderer-defects.md). Each such node opens its own server stream
 * (WatchThread, Attach) and the daemon's origin allows only so many (api/streamSlots.ts),
 * so a node attaches only while it is near the screen and its view tab stays the active
 * one, and at most INLINE_LIVE_MAX of them hold a stream at once: a node beyond the budget
 * shows "Attach", which takes the oldest holder's place.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";

/** Inline live streams (thread and terminal nodes) held at once, across every surface (pluginsdk/ui MaxLiveNodes). */
export const INLINE_LIVE_MAX = 2;

export interface InlineLiveState {
  /** Nodes holding a live slot, oldest first. */
  holders: readonly string[];
  /** Nodes that want one (on screen) but the budget is full, in the order they asked. */
  waiting: readonly string[];
}

const EMPTY: InlineLiveState = { holders: [], waiting: [] };

export const useInlineLiveStore = create<InlineLiveState>()(() => EMPTY);

// ---------------------------------------------------------------------------------------
// Pure reducers

/** A node asks for a slot: granted while there is room, else it waits. */
export function want(s: InlineLiveState, id: string, max = INLINE_LIVE_MAX): InlineLiveState {
  if (s.holders.includes(id) || s.waiting.includes(id)) return s;
  return s.holders.length < max ? { ...s, holders: [...s.holders, id] } : { ...s, waiting: [...s.waiting, id] };
}

/** A node lets go (scrolled away, unmounted): the first waiting node takes its slot. */
export function drop(s: InlineLiveState, id: string, max = INLINE_LIVE_MAX): InlineLiveState {
  if (!s.holders.includes(id) && !s.waiting.includes(id)) return s;
  let holders = s.holders.filter((h) => h !== id);
  let waiting = s.waiting.filter((w) => w !== id);
  while (holders.length < max && waiting.length > 0) {
    holders = [...holders, waiting[0] as string];
    waiting = waiting.slice(1);
  }
  return { holders, waiting };
}

/** "Attach" on a waiting node: it takes the oldest holder's slot; that one waits instead. */
export function take(s: InlineLiveState, id: string, max = INLINE_LIVE_MAX): InlineLiveState {
  if (s.holders.includes(id)) return s;
  const waiting = s.waiting.filter((w) => w !== id);
  if (s.holders.length < max) return { holders: [...s.holders, id], waiting };
  const [oldest, ...rest] = s.holders;
  return { holders: [...rest, id], waiting: oldest === undefined ? waiting : [...waiting, oldest] };
}

// ---------------------------------------------------------------------------------------
// Hooks

/**
 * Holds an inline live slot for `id` while `wanted`. `live`: the node may open its
 * stream; `over`: it wants one but the budget is full (show Attach, which calls `take`).
 */
export function useLiveSlot(id: string, wanted: boolean): { live: boolean; over: boolean; take: () => void } {
  useEffect(() => {
    if (!wanted) return;
    useInlineLiveStore.setState((s) => want(s, id));
    return () => {
      useInlineLiveStore.setState((s) => drop(s, id));
    };
  }, [id, wanted]);
  const live = useInlineLiveStore((s) => s.holders.includes(id));
  const over = useInlineLiveStore((s) => s.waiting.includes(id));
  return {
    live: wanted && live,
    over: wanted && over,
    take: () => {
      useInlineLiveStore.setState((s) => take(s, id));
    },
  };
}

/** How far outside the panel's visible box a node still counts as on screen. */
const ON_SCREEN_MARGIN = "160px 0px";

/**
 * Whether the element is on screen (or within ON_SCREEN_MARGIN of it) in its scroll box
 * (the side panel's [data-scroll-root]). False until the first observation; true where
 * there is no IntersectionObserver (unit tests).
 */
export function useOnScreen(el: HTMLElement | null): boolean {
  const [on, setOn] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return;
    const root = el.parentElement?.closest<HTMLElement>("[data-scroll-root]") ?? null;
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last) setOn(last.isIntersecting);
      },
      { root, rootMargin: ON_SCREEN_MARGIN },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [el]);
  return on;
}

/**
 * Whether the surface is leaving the view tab on screen: the user clicked another of the
 * plugin's tabs and its act is in flight. The old view stays drawn until the plugin's next
 * view, but its live nodes let go now (their streams must not hold up the act).
 */
export function useLeavingViewTab(watchKey: string): boolean {
  return usePluginSurfacesStore((s) => {
    const tabs = s.watches[watchKey]?.view?.tabs;
    const pending = s.pending[watchKey];
    if (!tabs || !pending) return false;
    return tabs.items.some((t) => t.key !== tabs.active && pending[t.key] === true);
  });
}
