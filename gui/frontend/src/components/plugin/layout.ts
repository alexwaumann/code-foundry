/**
 * The plugin view's layout nodes (docs/notes/plugins-layout-1-columns-pane.md,
 * plugins-layout-2-grid-inline.md, plugins-layout-3-chrome.md): how a columns node decides
 * between side by side and its collapse, and how wide its columns are; how many columns a
 * grid has and what an item spans; a spacer's size; a container's widest. The numbers are
 * pluginsdk/ui's (ColumnMinWidth, ColumnGap, GridMinWidth, ContainerNarrowWidth, ...; Go
 * tests keep them equal).
 */
import { useLayoutEffect, useState, type CSSProperties } from "react";
import type { ColumnData, ColumnsData, ContainerData, GridData, GridItemData, MasterDetailData, SpacerData } from "@/api/plugin";

/** The width a weighted column needs side by side; it never gets less. */
export const COLUMN_MIN_WIDTH = 240;
/** The space between columns side by side (the design system's pane gap, gap-3). */
export const COLUMN_GAP = 12;

const MAX_WEIGHT = 6;

/** A "narrow" container's widest (reading width, forms). */
export const CONTAINER_NARROW_WIDTH = 680;
/** A "wide" container's widest (a page's main column). */
export const CONTAINER_WIDE_WIDTH = 1080;

/** A container's max-width in px, or null for "full" (absent, or a width this GUI does not know). */
export function containerMaxWidth(width: ContainerData["width"]): number | null {
  if (width === "narrow") return CONTAINER_NARROW_WIDTH;
  if (width === "wide") return CONTAINER_WIDE_WIDTH;
  return null;
}

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

/** A grid column's least width when the grid sets none. */
export const GRID_MIN_WIDTH = 240;
/** A grid's least column width the daemon takes, and the most. */
export const GRID_MIN_WIDTH_RANGE = [160, 480] as const;
/** The most columns a grid has, however wide. */
export const GRID_MAX_COLUMNS = 6;
/** The space between a grid's columns and rows (gap-3, like columns). */
export const GRID_GAP = 12;
/** The most columns an item spans. */
export const GRID_MAX_SPAN = 2;

/** A grid's least column width: its minWidth in range, else GRID_MIN_WIDTH. */
export function gridMinWidth(data: GridData): number {
  const w = data.minWidth;
  return typeof w === "number" && Number.isFinite(w) && w >= GRID_MIN_WIDTH_RANGE[0] && w <= GRID_MIN_WIDTH_RANGE[1] ? w : GRID_MIN_WIDTH;
}

/**
 * How many columns a grid `width` px wide has: max(1, floor((width + gap) / (minWidth +
 * gap))), at most GRID_MAX_COLUMNS; 1 before it is measured (null), so it stacks.
 */
export function gridColumns(width: number | null, minWidth: number): number {
  if (width === null) return 1;
  return Math.min(GRID_MAX_COLUMNS, Math.max(1, Math.floor((width + GRID_GAP) / (minWidth + GRID_GAP))));
}

/** The columns an item spans in a grid of `columns`: its span (1..2, absent or out of range 1), at most the columns. */
export function gridSpan(item: GridItemData, columns: number): number {
  const s = item.span ?? 1;
  return Math.min(columns, Number.isInteger(s) && s >= 1 && s <= GRID_MAX_SPAN ? s : 1);
}

/** A spacer's size when it sets none. */
export const SPACER_SIZE = 12;

/** A spacer's size in px: its size in 4..64, else SPACER_SIZE. */
export function spacerSize(data: SpacerData): number {
  const s = data.size;
  return typeof s === "number" && Number.isInteger(s) && s >= 4 && s <= 64 ? s : SPACER_SIZE;
}

/** The space between a group's items (gap-2). */
export const GROUP_GAP = 8;

/** A master-detail's list width when it sets none (docs/notes/plugins-layout-4-master-detail.md). */
export const MASTER_DETAIL_LIST_WIDTH = 280;
/** The list widths the daemon takes. */
export const MASTER_DETAIL_LIST_WIDTH_RANGE = [200, 400] as const;
/** The detail's least width beside the list. */
export const MASTER_DETAIL_MIN_DETAIL = 320;
/** The space between the list and the detail side by side (gap-3, like columns). */
export const MASTER_DETAIL_GAP = 12;

/** A master-detail's list width: its listWidth in range, else MASTER_DETAIL_LIST_WIDTH. */
export function masterDetailListWidth(data: MasterDetailData): number {
  const w = data.listWidth;
  return typeof w === "number" && Number.isInteger(w) && w >= MASTER_DETAIL_LIST_WIDTH_RANGE[0] && w <= MASTER_DETAIL_LIST_WIDTH_RANGE[1] ? w : MASTER_DETAIL_LIST_WIDTH;
}

/**
 * Whether a master-detail `width` px wide shows its list and detail side by side: at least
 * listWidth + MASTER_DETAIL_GAP + MASTER_DETAIL_MIN_DETAIL (612 px by default). Not
 * measured yet (null): no, the list alone, so the side panel never flashes two sides.
 */
export function masterDetailWide(width: number | null, listWidth: number): boolean {
  return width !== null && width >= listWidth + MASTER_DETAIL_GAP + MASTER_DETAIL_MIN_DETAIL;
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
