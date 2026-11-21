import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useWidth } from "@/lib/useWidth";
import { cn } from "@/lib/utils";
import { columnLabel, MAX_COLUMN_CH, type Column, type Sort } from "./table";
import "./data.css";

/** A grid row's height in px, its bottom border included. */
export const GRID_ROW = 26;
/** Padding (12 px a side) and the left border of a cell. */
const CELL_PX = 25;

/** What an expandable grid (JSON Lines) does with a row. */
export interface GridExpand {
  readonly isOpen: (row: number) => boolean;
  readonly toggle: (row: number) => void;
  /** Drawn under the open row, across the visible width. */
  readonly render: (row: number) => ReactNode;
}

export interface DataGridProps {
  readonly columns: readonly Column[];
  /** The rows in the order shown: indexes into the caller's rows. */
  readonly order: readonly number[];
  /** The gutter's number for a row (its place in the file); also the row's key. */
  readonly rowNumber: (row: number) => number;
  readonly cell: (row: number, col: number) => ReactNode;
  /** A row drawn as one cell across every column (a JSON Lines line that is not an object), or null. */
  readonly span?: (row: number) => ReactNode;
  /** Rows marked as wrong (a line that is not JSON). */
  readonly flagged?: (row: number) => boolean;
  readonly sort: Sort | null;
  readonly onSort: (col: number) => void;
  readonly expand?: GridExpand;
  /** Shown under the header when there are no rows. */
  readonly empty: ReactNode;
  readonly label: string;
  readonly testId: string;
}

const widthOf = (ch: number) => `calc(${String(ch)}ch + ${String(CELL_PX)}px)`;

/**
 * A read-only data grid: a sticky header row whose cells sort (ascending, descending, file
 * order), a sticky gutter of row numbers that stay with their rows, numeric columns
 * right-aligned in tabular figures, horizontal scroll for wide tables, and rows virtualized
 * (a 1 MiB CSV is tens of thousands). With `expand`, a row opens under itself on click or
 * Enter, and the keyboard moves a current row (Up/Down, Home/End, Page keys, Right/Left
 * open and close).
 */
export function DataGrid({ columns, order, rowNumber, cell, span, flagged, sort, onSort, expand, empty, label, testId }: DataGridProps) {
  const [scrollRef, viewWidth] = useWidth();
  const id = useId();
  const [active, setActive] = useState(0);
  const at = Math.min(active, order.length - 1);
  // One character more than the longest value: text a hair wider than its box would be cut.
  const widths = columns.map((c, i) => Math.min(MAX_COLUMN_CH, Math.max(c.width, columnLabel(c.name, i).length + 2)) + 1);
  const allCh = widths.reduce((a, b) => a + b, 0);
  const allWidth = columns.length > 0 ? `calc(${String(allCh)}ch + ${String(CELL_PX * columns.length)}px)` : undefined;
  let last = 0;
  for (const r of order) last = Math.max(last, rowNumber(r));
  const gutter = `calc(${String(Math.max(2, String(last).length))}ch + 20px)`;

  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW,
    getItemKey: (i) => rowNumber(order[i] ?? 0),
    overscan: 12,
    scrollMargin: GRID_ROW,
    measureElement: expand ? (el) => el.getBoundingClientRect().height : undefined,
  });
  const margin = v.options.scrollMargin;

  const go = (i: number) => {
    const to = Math.max(0, Math.min(order.length - 1, i));
    setActive(to);
    v.scrollToIndex(to, { align: "auto" });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!expand || e.metaKey || e.ctrlKey || e.altKey) return;
    const row = order[at];
    if (row === undefined) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / GRID_ROW) - 2);
    const keys: Record<string, () => void> = {
      ArrowDown: () => {
        go(at + 1);
      },
      ArrowUp: () => {
        go(at - 1);
      },
      PageDown: () => {
        go(at + page);
      },
      PageUp: () => {
        go(at - page);
      },
      Home: () => {
        go(0);
      },
      End: () => {
        go(order.length - 1);
      },
      Enter: () => {
        expand.toggle(row);
      },
      " ": () => {
        expand.toggle(row);
      },
      ArrowRight: () => {
        if (!expand.isOpen(row)) expand.toggle(row);
      },
      ArrowLeft: () => {
        if (expand.isOpen(row)) expand.toggle(row);
      },
    };
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  };

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={label}
      aria-rowcount={order.length + 1}
      aria-colcount={columns.length}
      aria-activedescendant={expand && order.length > 0 ? `${id}-${String(at)}` : undefined}
      tabIndex={0}
      className="cf-grid min-h-0 flex-1 overflow-auto text-caption-sm text-code text-cf-text outline-none"
      data-testid={testId}
      data-rows={order.length}
      onKeyDown={onKeyDown}
    >
      <div role="row" aria-rowindex={1} className="sticky top-0 z-[2] flex w-max min-w-full border-b border-cf-divider bg-cf-surface-sunken font-semibold" style={{ height: GRID_ROW }}>
        <div className="sticky left-0 z-[1] flex-none bg-cf-surface-sunken" style={{ width: gutter }} />
        {columns.map((c, i) => {
          const sorted = sort?.col === i ? sort.dir : null;
          const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
          return (
            <div key={i} role="columnheader" aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"} className="flex-none border-l border-cf-divider" style={{ width: widthOf(widths[i] ?? 0) }} data-testid="grid-header">
              <button
                type="button"
                className={cn("group flex h-full w-full items-center gap-1 px-3 outline-none hover:bg-cf-control-hover focus-visible:bg-cf-control-hover", c.numeric && "flex-row-reverse")}
                onClick={() => {
                  onSort(i);
                }}
              >
                <span className={cn("min-w-0 truncate", c.name === "" && "font-normal text-cf-text-muted")}>{columnLabel(c.name, i)}</span>
                <Icon className={cn("size-3 flex-none", sorted ? "text-cf-text" : "text-cf-text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100")} aria-hidden />
              </button>
            </div>
          );
        })}
        <div className="flex-1 border-l border-cf-divider" />
      </div>
      {order.length === 0 ? (
        <div className="sticky left-0 px-3 py-2 text-caption" data-testid={`${testId}-empty`}>
          {empty}
        </div>
      ) : (
        <div className="relative w-max min-w-full" style={{ height: v.getTotalSize() }}>
          {v.getVirtualItems().map((vi) => {
            const row = order[vi.index];
            if (row === undefined) return null;
            const open = expand?.isOpen(row) === true;
            const whole = span?.(row);
            return (
              <div
                key={vi.key}
                ref={expand ? v.measureElement : undefined}
                data-index={vi.index}
                id={`${id}-${String(vi.index)}`}
                role="row"
                aria-rowindex={vi.index + 2}
                aria-expanded={expand ? open : undefined}
                aria-selected={expand ? vi.index === at : undefined}
                className="cf-grid-row absolute top-0 left-0 w-max min-w-full"
                style={{ transform: `translateY(${String(vi.start - margin)}px)` }}
                data-open={open || undefined}
                data-active={expand && vi.index === at ? "" : undefined}
                data-flagged={flagged?.(row) || undefined}
                data-testid="grid-row"
              >
                <div
                  className="cf-grid-line flex w-max min-w-full border-b border-cf-divider"
                  style={{ height: GRID_ROW }}
                  onClick={
                    expand &&
                    (() => {
                      setActive(vi.index);
                      expand.toggle(row);
                    })
                  }
                >
                  <div role="rowheader" className="cf-grid-gutter sticky left-0 z-[1] flex flex-none items-center justify-end px-2.5 text-cf-text-muted tabular-nums" style={{ width: gutter }}>
                    {rowNumber(row)}
                  </div>
                  {whole != null ? (
                    <div role="gridcell" aria-colspan={Math.max(1, columns.length)} className={cn("flex items-center truncate border-l border-cf-divider px-3", columns.length === 0 && "flex-1")} style={{ width: allWidth }}>
                      <span className="truncate">{whole}</span>
                    </div>
                  ) : (
                    columns.map((c, i) => (
                      <div key={i} role="gridcell" className={cn("flex flex-none items-center border-l border-cf-divider px-3", c.numeric && "justify-end tabular-nums")} style={{ width: widthOf(widths[i] ?? 0) }}>
                        <span className="truncate">{cell(row, i)}</span>
                      </div>
                    ))
                  )}
                  <div className="flex-1 border-l border-cf-divider" />
                </div>
                {open && (
                  <div className="sticky left-0 border-b border-cf-divider bg-cf-surface py-1" style={{ width: viewWidth }}>
                    <div className="border-l-2 border-cf-accent bg-cf-surface-sunken" style={{ marginLeft: gutter }}>
                      {expand.render(row)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
