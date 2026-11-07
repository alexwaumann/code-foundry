import { useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { NavContext } from "@/lib/nav";

/** Lists longer than this are virtualized inside a scroll box of `maxHeight`. */
export const VIRTUALIZE_OVER = 60;

interface RowListProps<T> {
  rows: readonly T[];
  rowKey: (row: T) => string;
  render: (row: T) => ReactNode;
  rowHeight: number;
  /** Pixels, or a CSS length ("100%") when the list fills a box of a definite height. */
  maxHeight?: number | string;
  /** Short lists scroll inside maxHeight too (a fixed region in a panel); long ones always do. */
  capped?: boolean;
  /**
   * Whether the list is long enough to virtualize; by default more than VIRTUALIZE_OVER
   * rows. A list that mixes in non-row lines (group labels) decides by its rows alone.
   */
  virtualize?: boolean;
  /** Rows come and go under the reader (a live list): stay on the same row, not the same offset. */
  keepPlace?: boolean;
  testId?: string;
}

/**
 * For `keepPlace`: the row at the top of the scroll box, and how far into it. When the rows
 * change it goes back to that row, wherever it moved; a row that went leaves the offset alone.
 */
function useKeepPlace<T>(on: boolean, rows: readonly T[], rowKey: (row: T) => string, rowHeight: number): [box: RefObject<HTMLDivElement | null>, onScroll: () => void] {
  const box = useRef<HTMLDivElement>(null);
  const place = useRef<{ key: string; into: number } | null>(null);
  const restore = useEffectEvent(() => {
    const at = place.current;
    const i = at ? rows.findIndex((r) => rowKey(r) === at.key) : -1;
    if (at && box.current && i >= 0) box.current.scrollTop = i * rowHeight + at.into;
  });
  useLayoutEffect(() => {
    if (on) restore();
  }, [on, rows]);
  const onScroll = () => {
    const top = box.current?.scrollTop ?? 0;
    const row = rows[Math.floor(top / rowHeight)];
    place.current = on && top > 0 && row !== undefined ? { key: rowKey(row), into: top % rowHeight } : null;
  };
  return [box, onScroll];
}

/**
 * A list opening with the cursor in it shows the cursor's row, as a list folded away and back
 * does: it comes back at the top. Set here, before the rows' effects run, and only for a row
 * of this list, as nothing else would answer.
 */
function useOpenOnCursor<T>(rows: readonly T[], rowKey: (row: T) => string): void {
  const { cursorKey, reveal } = useContext(NavContext);
  const open = useEffectEvent(() => {
    if (cursorKey !== null && rows.some((r) => rowKey(r) === cursorKey)) reveal.owe(cursorKey);
  });
  useLayoutEffect(() => {
    open();
  }, []);
}

/**
 * Renders rows directly when short, virtualized (fixed row height) when long. When the
 * page's keyboard cursor moves to a row that is not mounted, it scrolls to it first.
 */
export function RowList<T>({ rows, rowKey, render, rowHeight, maxHeight = 520, capped = false, virtualize = rows.length > VIRTUALIZE_OVER, keepPlace = false, testId }: RowListProps<T>) {
  if (!virtualize) return <PlainRows rows={rows} rowKey={rowKey} render={render} rowHeight={rowHeight} maxHeight={maxHeight} capped={capped} keepPlace={keepPlace} testId={testId} />;
  return <VirtualRows rows={rows} rowKey={rowKey} render={render} rowHeight={rowHeight} maxHeight={maxHeight} keepPlace={keepPlace} testId={testId} />;
}

function PlainRows<T>({ rows, rowKey, render, rowHeight, maxHeight, capped, keepPlace, testId }: Required<Omit<RowListProps<T>, "testId" | "virtualize">> & { testId?: string }) {
  const [scrollRef, onScroll] = useKeepPlace(keepPlace, rows, rowKey, rowHeight);
  useOpenOnCursor(rows, rowKey);
  return (
    <div ref={scrollRef} className={capped ? "overflow-y-auto" : undefined} style={capped ? { maxHeight } : undefined} data-testid={testId} data-virtual="false" onScroll={onScroll}>
      {rows.map((r) => (
        <div key={rowKey(r)} style={{ height: rowHeight }}>
          {render(r)}
        </div>
      ))}
    </div>
  );
}

function VirtualRows<T>({ rows, rowKey, render, rowHeight, maxHeight, keepPlace, testId }: Required<Omit<RowListProps<T>, "testId" | "capped" | "virtualize">> & { testId?: string }) {
  const [scrollRef, onScroll] = useKeepPlace(keepPlace, rows, rowKey, rowHeight);
  useOpenOnCursor(rows, rowKey);
  const { cursorKey: cursor, reveal } = useContext(NavContext);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight, overscan: 12 });
  // Only for a row owed it: new rows under a list being read must not scroll it. The row, once
  // mounted, settles the debt, and scrolls whatever is around this box.
  const mount = useEffectEvent((key: string) => {
    const i = rows.findIndex((r) => rowKey(r) === key);
    if (i >= 0) v.scrollToIndex(i, { align: "auto" });
  });
  useEffect(() => {
    if (cursor !== null && reveal.owes(cursor)) mount(cursor);
  }, [cursor, reveal]);
  return (
    <div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight }} data-testid={testId} data-virtual="true" onScroll={onScroll}>
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((vi) => {
          const r = rows[vi.index];
          if (r === undefined) return null;
          return (
            <div key={rowKey(r)} style={{ position: "absolute", top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${String(vi.start)}px)` }}>
              {render(r)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
