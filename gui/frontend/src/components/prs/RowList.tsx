import { useEffect, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useNavCursor } from "@/lib/nav";

/** Lists longer than this are virtualized inside a scroll box of `maxHeight`. */
export const VIRTUALIZE_OVER = 60;

interface RowListProps<T> {
  rows: readonly T[];
  rowKey: (row: T) => string;
  render: (row: T) => ReactNode;
  rowHeight: number;
  maxHeight?: number;
  testId?: string;
}

/**
 * Renders rows directly when short, virtualized (fixed row height) when long. When the
 * page's keyboard cursor lands on a row that is not mounted, it scrolls to it first.
 */
export function RowList<T>({ rows, rowKey, render, rowHeight, maxHeight = 520, testId }: RowListProps<T>) {
  if (rows.length <= VIRTUALIZE_OVER) {
    return (
      <div data-testid={testId} data-virtual="false">
        {rows.map((r) => (
          <div key={rowKey(r)} style={{ height: rowHeight }}>
            {render(r)}
          </div>
        ))}
      </div>
    );
  }
  return <VirtualRows rows={rows} rowKey={rowKey} render={render} rowHeight={rowHeight} maxHeight={maxHeight} testId={testId} />;
}

function VirtualRows<T>({ rows, rowKey, render, rowHeight, maxHeight, testId }: Required<Omit<RowListProps<T>, "testId">> & { testId?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cursor = useNavCursor();
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight, overscan: 12 });
  useEffect(() => {
    if (cursor === null) return;
    const i = rows.findIndex((r) => rowKey(r) === cursor);
    if (i >= 0) v.scrollToIndex(i, { align: "auto" });
  }, [cursor, rows, rowKey, v]);
  return (
    <div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight }} data-testid={testId} data-virtual="true">
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
