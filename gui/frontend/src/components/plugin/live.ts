/**
 * When a plugin's thread or terminal node holds a live stream: each opens its own server
 * stream (WatchThread, Attach), only while it is near the screen and layout has settled, and
 * only the first node of a view naming that thread or terminal
 * (docs/notes/ws-remove-slots.md).
 */
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

/** How far outside the panel's visible box a node still counts as on screen. */
const ON_SCREEN_MARGIN = "160px 0px";

/**
 * The frames a node must stay on screen before it counts. A grid or columns measures its own
 * width (layout.ts useElementWidth), and one inside columns first measures them stacked: a
 * frame later it still has six columns in a quarter of the width, so a whole wall sits on
 * screen in 38 px nodes. Each level of nesting settles a frame after the one around it, and a
 * view is at most ui.MaxDepth (4) deep. A node a scroll passes opens nothing either.
 */
export const SETTLE_FRAMES = 4;

/**
 * Whether the element is on screen (or within ON_SCREEN_MARGIN of it) in its scroll box
 * (the pane's [data-scroll-root]) and has been for SETTLE_FRAMES. False until then;
 * leaving is at once. True where there is no IntersectionObserver (unit tests).
 */
export function useOnScreen(el: HTMLElement | null): boolean {
  const [on, setOn] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return;
    const root = el.parentElement?.closest<HTMLElement>("[data-scroll-root]") ?? null;
    let frame = 0;
    const settle = (left: number) => {
      frame = requestAnimationFrame(() => {
        if (left > 1) settle(left - 1);
        else setOn(true);
      });
    };
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (!last) return;
        cancelAnimationFrame(frame);
        if (last.isIntersecting) settle(SETTLE_FRAMES);
        else setOn(false);
      },
      { root, rootMargin: ON_SCREEN_MARGIN },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [el]);
  return on;
}

/** The nodes drawn now that name one thread or terminal in one view, and who follows the first. */
interface Named {
  nodes: Set<HTMLElement>;
  first: HTMLElement | null;
  listeners: Set<() => void>;
}

const named = new Map<string, Named>();

function namedOf(key: string): Named {
  let n = named.get(key);
  if (!n) {
    n = { nodes: new Set(), first: null, listeners: new Set() };
    named.set(key, n);
  }
  return n;
}

function forget(key: string, n: Named): void {
  if (n.nodes.size === 0 && n.listeners.size === 0) named.delete(key);
}

/** The node earliest in the document; only nodes drawn count, so never one in a hidden tab or side. */
function earliest(nodes: Set<HTMLElement>): HTMLElement | null {
  let first: HTMLElement | null = null;
  for (const el of nodes) {
    if (!first || first.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) first = el;
  }
  return first;
}

function refresh(n: Named): void {
  const first = earliest(n.nodes);
  if (first === n.first) return;
  n.first = first;
  for (const l of n.listeners) l();
}

/**
 * Whether an earlier node of this view already shows the same thread or terminal (`id`). A
 * view may name one in any number of nodes, and each would be a whole xterm or conversation,
 * so a repeat draws ShownAbove and holds nothing. The plugin's limits (32 threads, 16
 * terminals) then bound what a view draws. `scope` is the view's watch: two surfaces keep
 * their own views.
 */
export function useRepeated(scope: string, id: string, el: HTMLElement | null): boolean {
  const key = `${scope}\n${id}`;
  const subscribe = useCallback(
    (listener: () => void) => {
      const n = namedOf(key);
      n.listeners.add(listener);
      return () => {
        n.listeners.delete(listener);
        forget(key, n);
      };
    },
    [key],
  );
  const first = useSyncExternalStore(subscribe, () => named.get(key)?.first ?? null);
  useLayoutEffect(() => {
    if (!el) return;
    const n = namedOf(key);
    n.nodes.add(el);
    refresh(n);
    return () => {
      n.nodes.delete(el);
      refresh(n);
      forget(key, n);
    };
  }, [key, el]);
  return first !== null && first !== el;
}
