import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** Lists longer than this are virtualized (RowList's VIRTUALIZE_OVER is for fixed-height rows). */
export const VIRTUALIZE_OVER = 40;

interface VirtualStackProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string;
  /** One item; `index` and `count` let it draw rail segments (first and last differ). */
  render: (item: T, index: number, count: number) => ReactNode;
  /** Estimated height of one item in px; rows are measured once mounted. */
  estimate: number;
  className?: string;
  testId?: string;
}

/** The nearest scrolling ancestor ([data-scroll-root] first, e.g. the side panel's body). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  const marked = el.parentElement?.closest<HTMLElement>("[data-scroll-root]");
  if (marked) return marked;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/**
 * A vertical list of variable-height items. Short lists render directly; long ones
 * (over VIRTUALIZE_OVER) mount only what is near the viewport of the scrolling ancestor,
 * measuring each item, so a pull request with hundreds of comments stays cheap. The list
 * does not scroll itself: it lives in the page's own scroll box, offset by the content
 * above it (scrollMargin, re-measured when that content changes size).
 */
export function VirtualStack<T>(props: VirtualStackProps<T>) {
  const { items, itemKey, render, className, testId } = props;
  if (items.length <= VIRTUALIZE_OVER) {
    return (
      <div className={className} data-testid={testId} data-virtual="false">
        {items.map((it, i) => (
          <Fragment key={itemKey(it)}>{render(it, i, items.length)}</Fragment>
        ))}
      </div>
    );
  }
  return <VirtualItems {...props} />;
}

function VirtualItems<T>({ items, itemKey, render, estimate, className, testId }: VirtualStackProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    const el = list ? scrollParent(list) : null;
    setScrollEl(el);
    if (!list || !el) return;
    const measure = () => {
      setMargin(Math.round(list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Content above the list (a folded section, a banner) moves it: watch the scroll box's
    // content. Measure in the next frame: a re-render inside the observer's callback would
    // resize what it observes in the same frame (a "ResizeObserver loop" error).
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    for (const child of el.children) ro.observe(child);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimate,
    overscan: 6,
    scrollMargin: margin,
    // Measuring re-renders asynchronously: a flushSync inside the size observer resized
    // what it observed in the same frame ("ResizeObserver loop" errors).
    useFlushSync: false,
    getItemKey: (i) => {
      const it = items[i];
      return it === undefined ? i : itemKey(it);
    },
  });

  return (
    <div ref={listRef} className={className} data-testid={testId} data-virtual="true" style={{ position: "relative", height: v.getTotalSize() }}>
      {v.getVirtualItems().map((vi) => {
        const it = items[vi.index];
        if (it === undefined) return null;
        return (
          <div key={vi.key} data-index={vi.index} ref={v.measureElement} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${String(vi.start - margin)}px)` }}>
            {render(it, vi.index, items.length)}
          </div>
        );
      })}
    </div>
  );
}
