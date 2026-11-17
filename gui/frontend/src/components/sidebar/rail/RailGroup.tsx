import { useImperativeHandle, useRef, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ShellRow } from "@/lib/shellSections";
import { cn } from "@/lib/utils";
import { edgeMask, RAIL_GAP, RAIL_TILE, railGroupHeight } from "./railLook";
import { useEdges } from "../shell/useEdges";
import { RailRowView } from "./RailRows";

/** Brings the icon at an index into view. */
export type RailScrollTo = (index: number) => void;

interface RailGroupProps {
  rows: readonly ShellRow[];
  selectedKey: string | null;
  cursorKey: string | null;
  onActivate: (row: ShellRow) => void;
  scrollTo: RefObject<RailScrollTo | null>;
  /** At most this many icons tall, then it scrolls (Needs you); absent: it takes the height left (Active). */
  maxIcons?: number;
  testId: string;
}

/**
 * One group of the rail's icons in its own scroll container (docs/notes/sidebar-rail.md):
 * virtualized, never a scrollbar, and the edge that has more to scroll to fades out.
 */
export function RailGroup({ rows, selectedKey, cursorKey, onActivate, scrollTo, maxIcons, testId }: RailGroupProps) {
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => RAIL_TILE,
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
    gap: RAIL_GAP,
  });
  useImperativeHandle(scrollTo, () => (i) => {
    virtualizer.scrollToIndex(i, { align: "auto" });
  }, [virtualizer]);
  const total = virtualizer.getTotalSize();
  const { top, bottom, onScroll } = useEdges(ref, total);
  const capped = maxIcons !== undefined;
  const mask = edgeMask(top, bottom);
  return (
    <div
      ref={ref}
      className={cn("w-full shrink-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", !capped && "min-h-[82px] flex-1")}
      style={{ ...(capped ? { height: Math.min(total, railGroupHeight(maxIcons)) } : null), maskImage: mask, WebkitMaskImage: mask }}
      data-testid={testId}
      data-fade-top={top || undefined}
      data-fade-bottom={bottom || undefined}
      onScroll={onScroll}
    >
      <div style={{ height: total, position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          return (
            <div key={row.key} data-index={vi.index} className="absolute inset-x-0 top-0 flex justify-center" style={{ height: RAIL_TILE, transform: `translateY(${String(vi.start)}px)` }}>
              <RailRowView row={row} selected={row.key === selectedKey} cursor={row.key === cursorKey} onActivate={onActivate} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
