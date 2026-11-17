import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Whether a scroller has more above and below what shows, kept up to date as it scrolls, as it
 * resizes and as its content grows (`contentHeight`). The rail's groups and its section cards
 * fade the edge that has more (railLook edgeMask; docs/notes/sidebar-rail.md).
 */
export function useEdges(ref: RefObject<HTMLDivElement | null>, contentHeight: number): { top: boolean; bottom: boolean; onScroll: () => void } {
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 0;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  }, [ref]);
  useEffect(() => {
    measure();
  }, [measure, contentHeight]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [ref, measure]);
  return { ...edges, onScroll: measure };
}
