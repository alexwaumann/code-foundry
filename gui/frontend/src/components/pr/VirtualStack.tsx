import { Fragment, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { VirtualScrollRoot } from "./virtualRoot";

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
  /**
   * A new one (by identity) brings its item into view and hands the item's element to
   * `done` in the commit that draws it (null when it is not a key of the list, or is not
   * drawn within two frames). A master-detail's Back focuses its chosen row with it.
   */
  reveal?: Reveal;
}

export interface Reveal {
  key: string;
  done: (item: HTMLElement | null) => void;
}


/**
 * The nearest scrolling ancestor where no VirtualScrollRoot is provided: the nearest marked
 * one first ([data-scroll-root], e.g. the side panel's body), else the nearest with overflow.
 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  const marked = el.parentElement?.closest<HTMLElement>("[data-scroll-root]");
  if (marked) return marked;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/** The box a list virtualizes against: the provided one, else the one scrollParent finds. */
function rootOf(list: HTMLElement, provided: HTMLElement | null | undefined): HTMLElement | null {
  return provided === undefined ? scrollParent(list) : provided;
}

/** The list's top in its scroll box's content (scrollMargin). */
function offsetIn(list: HTMLElement, el: HTMLElement): number {
  return Math.round(list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop);
}

/**
 * A vertical list of variable-height items. Short lists render directly; long ones
 * (over VIRTUALIZE_OVER) mount only what is near the viewport of the scrolling ancestor,
 * measuring each item, so a pull request with hundreds of comments stays cheap. The list
 * does not scroll itself: it lives in the nearest box that scrolls (VirtualScrollRoot, else
 * the page's own scroll box), offset by the content above it (scrollMargin, re-measured
 * when that content changes size).
 */
export function VirtualStack<T>(props: VirtualStackProps<T>) {
  if (props.items.length <= VIRTUALIZE_OVER) return <PlainItems {...props} />;
  return <VirtualItems {...props} />;
}

/** A short list, all drawn; a reveal is answered in the commit that brings it (focus() scrolls the item into view). */
function PlainItems<T>({ items, itemKey, render, className, testId, reveal }: VirtualStackProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!reveal) return;
    const i = items.findIndex((it) => itemKey(it) === reveal.key);
    reveal.done(i < 0 ? null : ((listRef.current?.children[i] as HTMLElement | undefined) ?? null));
    // A new reveal only: the items are read as they are then.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [reveal]);
  return (
    <div ref={listRef} className={className} data-testid={testId} data-virtual="false">
      {items.map((it, i) => (
        <Fragment key={itemKey(it)}>{render(it, i, items.length)}</Fragment>
      ))}
    </div>
  );
}

function VirtualItems<T>({ items, itemKey, render, estimate, className, testId, reveal }: VirtualStackProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const provided = useContext(VirtualScrollRoot);
  const [found, setFound] = useState<HTMLElement | null>(null);
  // A provided root is known from the first render, so the virtualizer starts at its offset
  // (it scrolls its element to the offset it started with once it observes it).
  const scrollEl = provided === undefined ? found : provided;
  const [margin, setMargin] = useState(0);
  const revealing = useRef<Reveal | undefined>(undefined);

  useLayoutEffect(() => {
    const list = listRef.current;
    const el = list ? rootOf(list, provided) : null;
    setFound(el);
    if (!list || !el) return;
    const measure = () => {
      setMargin(offsetIn(list, el));
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
  }, [provided]);

  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimate,
    initialOffset: () => scrollEl?.scrollTop ?? 0,
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

  // A new reveal: scroll the item's estimated place into view and hand the virtualizer the
  // new offset (it reads its offset from scroll events, a frame later), so the re-render
  // this asks for draws the item before the paint. Given up (done(null)) after two frames.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!reveal || !list) return;
    const i = items.findIndex((it) => itemKey(it) === reveal.key);
    const el = rootOf(list, provided);
    if (i < 0 || !el) {
      reveal.done(null);
      return;
    }
    revealing.current = reveal;
    const at = offsetIn(list, el) + i * estimate;
    if (at < el.scrollTop || at + estimate > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, at - (el.clientHeight - estimate) / 2);
      v.scrollOffset = el.scrollTop;
      v.measure();
    }
    let late = 0;
    const soon = requestAnimationFrame(() => {
      late = requestAnimationFrame(() => {
        if (revealing.current !== reveal) return;
        revealing.current = undefined;
        reveal.done(null);
      });
    });
    return () => {
      cancelAnimationFrame(soon);
      cancelAnimationFrame(late);
    };
    // A new reveal only: the items are read as they are then.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [reveal]);

  // The revealed item, in the commit that draws it.
  useLayoutEffect(() => {
    const r = revealing.current;
    if (!r) return;
    const i = items.findIndex((it) => itemKey(it) === r.key);
    const item = listRef.current?.querySelector<HTMLElement>(`:scope > [data-index="${String(i)}"]`);
    if (!item) return;
    revealing.current = undefined;
    r.done(item);
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
