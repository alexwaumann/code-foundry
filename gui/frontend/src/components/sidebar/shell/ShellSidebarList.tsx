import { useImperativeHandle, useRef, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ShellRow } from "@/lib/shellSections";
import { cn } from "@/lib/utils";
import { useEventsStore } from "@/stores/events";
import { useThreadsStore } from "@/stores/threads";
import { FOOTERS, type FooterSection, type Row } from "@/lib/tree";
import { HEADER_HEIGHT, ONE_LINE_ROW, ROW_GAP, rowGap } from "../rowSizes";
import { SidebarRow } from "../SidebarRow";
import { useShellListRows } from "./listRows";
import { DraftRowView, MainHeaderView, ShellQuietRowView, ShellThreadRowView } from "./ShellRows";
import { ThreadListbox } from "./ThreadListbox";
import { useEdges } from "./useEdges";
import { edgeMask } from "../rail/railLook";

/**
 * The shell's thread list (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-16-sidebar.md),
 * in place of the classic SidebarList while the shell draws the window: the main list (Needs you,
 * then Active with the space's drafts below its pinned threads) scrolls on its own; the Working,
 * Snoozed and Archived footers sit under it as in the classic list (their caps, headers and
 * Snoozed and Archived rows are the classic ones). Rows are as tall as their content (a title
 * wraps to two lines; a row without a branch line or counts has no third line), so the panels
 * measure them. Keyboard, cursor and the context menu are the listbox's (ThreadListbox), shared with the rail.
 */

/** The most of the sidebar body a footer (header and rows) takes before its rows scroll. */
const FOOTER_CAPS: Readonly<Record<FooterSection, number>> = { working: 0.4, snoozed: 0.25, archived: 0.3 };

/** A main header's estimated height: its 22px toggle on the bottom, with room above it. */
const MAIN_HEADER_HEIGHT = 28;
/** A thread row's estimate before it is measured: three lines with a one-line title. */
const THREAD_ESTIMATE = 62;

type Panel = "main" | FooterSection;

function panelOf(row: ShellRow): Panel {
  return row.section === "working" || row.section === "snoozed" || row.section === "archived" ? row.section : "main";
}

function estimate(row: ShellRow | undefined): number {
  if (!row) return THREAD_ESTIMATE;
  if (row.kind === "header") return row.section === "needs" || row.section === "active" ? MAIN_HEADER_HEIGHT : HEADER_HEIGHT;
  if (row.section === "snoozed" || row.section === "archived") return ONE_LINE_ROW;
  return THREAD_ESTIMATE;
}

export type ScrollTo = (index: number) => void;

interface RowViewProps {
  row: ShellRow;
  selected: boolean;
  cursor: boolean;
  onActivate: (row: ShellRow) => void;
}

function RowView({ row, selected, cursor, onActivate }: RowViewProps) {
  switch (row.kind) {
    case "header":
      return row.section === "needs" || row.section === "active" ? <MainHeaderView row={row} /> : <SidebarRow row={row as Row} selected={false} cursor={false} onActivate={onActivate} />;
    case "draft":
      return <DraftRowView row={row} selected={selected} cursor={cursor} onActivate={onActivate} />;
    case "thread":
      if (row.section === "snoozed" || row.section === "archived") return <ShellQuietRowView row={row} selected={selected} cursor={cursor} onActivate={onActivate} />;
      return <ShellThreadRowView row={row} selected={selected} cursor={cursor} onActivate={onActivate} />;
  }
}

interface PanelRowsProps {
  rows: readonly ShellRow[];
  selectedKey: string | null;
  cursorKey: string | null;
  onActivate: (row: ShellRow) => void;
  scrollTo: RefObject<ScrollTo | null>;
  maxHeight?: number;
  gap: number;
  paddingStart: number;
  paddingEnd: number;
  /**
   * The rail's scrolling look (a section card's list, docs/notes/sidebar-rail.md): no scrollbar,
   * and the edge with more to scroll to fades out.
   */
  fade?: boolean;
  testId: string;
  children?: React.ReactNode;
}

/** One panel's rows in its own scroll container, virtualized; each row is measured as drawn. */
export function PanelRows({ rows, selectedKey, cursorKey, onActivate, scrollTo, maxHeight, gap, paddingStart, paddingEnd, fade = false, testId, children }: PanelRowsProps) {
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: (i) => estimate(rows[i]),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 10,
    gap,
    paddingStart,
    paddingEnd,
  });
  useImperativeHandle(scrollTo, () => (i) => {
    // The first row under the panel's leading headers (Needs you, Active) brings them along: the top.
    const lead = rows.slice(0, i).every((r) => r.kind === "header");
    if (lead) virtualizer.scrollToOffset(0);
    else virtualizer.scrollToIndex(i, { align: "auto" });
  }, [virtualizer, rows]);
  const total = virtualizer.getTotalSize();
  const footer = maxHeight !== undefined;
  const edges = useEdges(ref, total);
  const mask = fade ? edgeMask(edges.top, edges.bottom) : undefined;
  return (
    <div
      ref={ref}
      className={cn(footer ? "shrink-0 overflow-y-auto" : "min-h-0 flex-1 overflow-y-auto", fade && "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden")}
      style={{ ...(footer ? { height: Math.max(0, Math.min(total, maxHeight)) } : null), ...(mask ? { maskImage: mask, WebkitMaskImage: mask } : null) }}
      data-testid={testId}
      data-fade-top={(fade && edges.top) || undefined}
      data-fade-bottom={(fade && edges.bottom) || undefined}
      onScroll={fade ? edges.onScroll : undefined}
    >
      {children}
      {rows.length > 0 && (
        <div style={{ height: total, position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            // A header and a one-line row keep their fixed height; a thread or draft row is as tall as its lines.
            const fixed = row.kind === "header" || row.section === "snoozed" || row.section === "archived";
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                style={{ position: "absolute", top: 0, left: 0, right: 0, height: fixed ? estimate(row) : undefined, transform: `translateY(${String(vi.start)}px)` }}
              >
                <RowView row={row} selected={row.key === selectedKey} cursor={row.key === cursorKey} onActivate={onActivate} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ShellSidebarList({ bodyHeight }: { bodyHeight: number }) {
  const { rows, main, headers, footers } = useShellListRows();
  const scrollMain = useRef<ScrollTo>(null);
  const scrollWorking = useRef<ScrollTo>(null);
  const scrollSnoozed = useRef<ScrollTo>(null);
  const scrollArchived = useRef<ScrollTo>(null);
  const loaded = useThreadsStore((s) => s.loaded);
  const listError = useThreadsStore((s) => s.error);
  const streamError = useEventsStore((s) => s.streamError);

  const panels: Readonly<Record<Panel, { rows: readonly ShellRow[]; scrollTo: RefObject<ScrollTo | null> }>> = {
    main: { rows: main, scrollTo: scrollMain },
    working: { rows: footers.working, scrollTo: scrollWorking },
    snoozed: { rows: footers.snoozed, scrollTo: scrollSnoozed },
    archived: { rows: footers.archived, scrollTo: scrollArchived },
  };
  const scrollToRow = (row: ShellRow) => {
    const panel = panels[panelOf(row)];
    const local = panel.rows.indexOf(row);
    if (local >= 0) panel.scrollTo.current?.(local);
  };

  const loadError = streamError ?? listError;
  const emptyText = loaded ? null : loadError ? `Cannot list threads: ${loadError}. Retrying…` : "Loading…";
  return (
    <ThreadListbox rows={rows} scrollToRow={scrollToRow} testId="thread-list">
      {({ selectedKey, cursorKey, activate }) => {
        const footer = (section: FooterSection) => {
          const header = headers[section];
          if (header === null) return null;
          const cap = bodyHeight > 0 ? Math.max(0, Math.floor(bodyHeight * FOOTER_CAPS[section]) - HEADER_HEIGHT) : Number.POSITIVE_INFINITY;
          return (
            <div key={section} className="flex shrink-0 flex-col" data-testid={`sidebar-${section}`}>
              <div className="shrink-0" style={{ height: HEADER_HEIGHT }}>
                <SidebarRow row={header} selected={false} cursor={false} onActivate={activate} />
              </div>
              <PanelRows
                rows={footers[section]}
                selectedKey={selectedKey}
                cursorKey={cursorKey}
                onActivate={activate}
                scrollTo={panels[section].scrollTo}
                maxHeight={cap}
                gap={rowGap(section)}
                paddingStart={0}
                paddingEnd={footers[section].length > 0 ? 4 : 0}
                testId={`sidebar-${section}-rows`}
              />
            </div>
          );
        };
        return (
          <>
            <PanelRows
              rows={main}
              selectedKey={selectedKey}
              cursorKey={cursorKey}
              onActivate={activate}
              scrollTo={scrollMain}
              gap={ROW_GAP}
              paddingStart={0}
              paddingEnd={8}
              testId="sidebar-main"
            >
              {rows.length === 0 && emptyText !== null && (
                <p className="px-2 py-4 text-caption break-words" data-testid="thread-list-empty">
                  {emptyText}
                </p>
              )}
            </PanelRows>
            {FOOTERS.map(footer)}
          </>
        );
      }}
    </ThreadListbox>
  );
}
