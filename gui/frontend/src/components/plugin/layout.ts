/**
 * The plugin view's layout containers (docs/notes/plugins-layout-1-columns-pane.md): how a
 * columns node decides between side by side and its collapse, and how wide its columns are.
 * The numbers are pluginsdk/ui's (ColumnMinWidth, ColumnGap; a Go test keeps them equal).
 */
import { useLayoutEffect, useState, type CSSProperties } from "react";
import type { ColumnData, ColumnsData } from "@/api/plugin";

/** The width a weighted column needs side by side; it never gets less. */
export const COLUMN_MIN_WIDTH = 240;
/** The space between columns side by side (the design system's pane gap, gap-3). */
export const COLUMN_GAP = 12;

const MAX_WEIGHT = 6;

/** A column's fixed width (px) when it has one in range, else null (weighted). */
function fixedWidth(c: ColumnData): number | null {
  return typeof c.width === "number" && c.width > 0 ? c.width : null;
}

/** A weighted column's weight: 1..6, absent (or out of range) is 1. */
export function columnWeight(c: ColumnData): number {
  const w = c.weight ?? 1;
  return Number.isInteger(w) && w >= 1 && w <= MAX_WEIGHT ? w : 1;
}

/**
 * The width the columns need side by side: COLUMN_MIN_WIDTH a column (a fixed one wider
 * than that, its width) and the gaps. So the side panel (about 360 px) always stacks.
 */
export function columnsMinWidth(items: readonly ColumnData[]): number {
  const widths = items.reduce((sum, c) => sum + Math.max(COLUMN_MIN_WIDTH, fixedWidth(c) ?? 0), 0);
  return widths + COLUMN_GAP * Math.max(0, items.length - 1);
}

/** Whether the columns sit side by side in a container `width` px wide (null: not measured yet, so stacked). */
export function sideBySide(width: number | null, items: readonly ColumnData[]): boolean {
  return width !== null && items.length > 1 && width >= columnsMinWidth(items);
}

/** The columns a columns node shows: all side by side; stacked, all ("stack") or only the first ("first"). */
export function shownColumns(data: ColumnsData, row: boolean): readonly ColumnData[] {
  if (row || data.collapse !== "first") return data.items;
  return data.items.slice(0, 1);
}

/** A column's box side by side: a fixed width, or a share of what is left by weight, never under COLUMN_MIN_WIDTH. */
export function columnStyle(c: ColumnData): CSSProperties {
  const fixed = fixedWidth(c);
  if (fixed !== null) return { flex: `0 0 ${String(fixed)}px`, width: fixed, minWidth: 0 };
  return { flex: `${String(columnWeight(c))} 1 0px`, minWidth: COLUMN_MIN_WIDTH };
}

/**
 * The element's width in px, followed as it resizes (one ResizeObserver); null until it
 * is measured with a width (a hidden element keeps the last).
 */
export function useElementWidth(el: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.floor(w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [el]);
  return width;
}
