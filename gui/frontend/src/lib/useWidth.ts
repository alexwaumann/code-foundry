import { useLayoutEffect, useRef, useState } from "react";

/**
 * The client height of `ref`'s element, kept current as useWidth does its width; `initial`
 * until the first measure, and for a hidden element. Layout px under the page zoom
 * (lib/zoom.ts): an element's client box is laid out under it.
 */
export function useHeight(ref: React.RefObject<HTMLDivElement | null>, initial = 800): number {
  const [height, setHeight] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientHeight > 0) setHeight(el.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [ref]);
  return height;
}

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
