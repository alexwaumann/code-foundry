import { useLayoutEffect, useRef, useState } from "react";

/**
 * An element's client width, kept current with a ResizeObserver: the inline SVG charts
 * (Usage page, Pull Requests activity) draw at it. `initial` until the first measure,
 * which runs before paint; a hidden (zero-width) element keeps the last width.
 */
export function useWidth(initial = 960): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  return [ref, width];
}
