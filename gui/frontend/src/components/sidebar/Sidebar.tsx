import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectsNav } from "@/components/projects/ProjectsPage";
import { PullRequestsNav } from "@/components/prs/PullRequestsPage";
import { TITLE_BAND_HEIGHT, trafficLightGutter } from "@/components/window/titleBand";
import { buildSections, FOOTERS, isSessionRow, rowCache, sessionKey, type FooterSection, type HeaderRow, type Row, type SessionRow } from "@/lib/tree";
import { zoomFactor } from "@/lib/zoom";
import { decodeSessionListKeys, useSessionListKeys } from "@/stores/context";
import { useEventsStore } from "@/stores/events";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { useRowHeight } from "@/stores/settings";
import { RowMenu } from "./RowMenu";
import { ResizeHandle } from "./ResizeHandle";
import { RowTooltipsEnabled } from "./rowTooltips";
import { SidebarRow } from "./SidebarRow";
import { SidebarStatus } from "./SidebarStatus";
import { SidebarNewThread, SidebarToolbar } from "./SidebarToolbar";

/** A footer header's height; thread rows are two lines (rowHeight + SECOND_LINE), snoozed and archived rows one (rowHeight). */
const HEADER_HEIGHT = 26;
const SECOND_LINE = 15;

/** The most of the sidebar body a footer (header and rows) takes before its rows scroll. */
const FOOTER_CAPS: Readonly<Record<FooterSection, number>> = { working: 0.4, snoozed: 0.25, archived: 0.3 };

type Panel = "main" | FooterSection;

interface ListRows {
  /** Every row in one order (main, Working, Snoozed, Archived): the cursor, arrows and the menu use it. */
  rows: Row[];
  main: Row[];
  /** A footer's header, or null when the footer is empty (not rendered). */
  headers: Readonly<Record<FooterSection, HeaderRow | null>>;
  /** A footer's thread rows; none when it is collapsed. */
  footers: Readonly<Record<FooterSection, Row[]>>;
}

function splitFooter(rows: readonly Row[]): [HeaderRow | null, Row[]] {
  const [first, ...rest] = rows;
  return first?.kind === "header" ? [first, rest] : [null, [...rows]];
}

/**
 * The list's rows by panel. A rebuild (a thread moved between groups, one came, went, or
 * was archived) reuses the previous row object for every row whose key and group are
 * unchanged (rowCache over the whole order), so the memoized SidebarRow re-renders only the
 * rows that actually changed.
 */
function useListRows(): ListRows {
  const sessionKeys = useSessionListKeys();
  const workingCollapsed = useUiStore((s) => s.workingCollapsed);
  const snoozedCollapsed = useUiStore((s) => s.snoozedCollapsed);
  const archivedCollapsed = useUiStore((s) => s.archivedCollapsed);
  const [stable] = useState(rowCache);
  return useMemo(() => {
    const sec = buildSections(decodeSessionListKeys(sessionKeys), { workingCollapsed, snoozedCollapsed, archivedCollapsed });
    const rows = stable([...sec.main, ...FOOTERS.flatMap((f) => sec[f])]);
    const headers: Record<FooterSection, HeaderRow | null> = { working: null, snoozed: null, archived: null };
    const footers: Record<FooterSection, Row[]> = { working: [], snoozed: [], archived: [] };
    let at = sec.main.length;
    for (const f of FOOTERS) {
      [headers[f], footers[f]] = splitFooter(rows.slice(at, at + sec[f].length));
      at += sec[f].length;
    }
    return { rows, main: rows.slice(0, sec.main.length), headers, footers };
  }, [stable, sessionKeys, workingCollapsed, snoozedCollapsed, archivedCollapsed]);
}

/** The panel a row is shown in. */
function panelOf(row: Row): Panel {
  return row.section === "working" || row.section === "snoozed" || row.section === "archived" ? row.section : "main";
}

/** Index of the next thread row from i in direction dir (skipping headers); i itself when none. */
function stepThread(rows: readonly Row[], i: number, dir: 1 | -1): number {
  for (let j = i + dir; j >= 0 && j < rows.length; j += dir) if (rows[j] && isSessionRow(rows[j] as Row)) return j;
  return i;
}

/**
 * An element's height in layout px (viewport px divided by the page zoom, lib/zoom.ts),
 * kept current with a ResizeObserver (it reports once when observing starts); 0 until then.
 */
function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setH(el.getBoundingClientRect().height / zoomFactor());
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [ref]);
  return h;
}

/** Scrolls a panel so its row at an index is in view (the keyboard cursor moved there). */
type ScrollTo = (index: number) => void;

interface PanelRowsProps {
  rows: readonly Row[];
  /** Size of one row (header, snoozed or archived, or two-line thread row). */
  sizeOf: (row: Row | undefined) => number;
  selectedKey: string | null;
  cursorKey: string | null;
  onActivate: (row: Row) => void;
  scrollTo: RefObject<ScrollTo | null>;
  /** The scroll container's height: the main list fills what is left (undefined), a footer is sized to fit its rows up to a cap. */
  maxHeight?: number;
  paddingStart: number;
  paddingEnd: number;
  testId: string;
  children?: React.ReactNode;
}

/**
 * One panel's rows in its own scroll container, virtualized (TanStack Virtual). The main
 * list takes the remaining height; a footer's rows are as tall as they need, up to
 * `maxHeight`, then scroll inside the footer.
 */
function PanelRows({ rows, sizeOf, selectedKey, cursorKey, onActivate, scrollTo, maxHeight, paddingStart, paddingEnd, testId, children }: PanelRowsProps) {
  const ref = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: (i) => sizeOf(rows[i]),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 10,
    paddingStart,
    paddingEnd,
  });
  // appearance.density changes the row height, and rows move between panels; drop the cached sizes.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, sizeOf, rows]);
  useImperativeHandle(scrollTo, () => (i) => {
    virtualizer.scrollToIndex(i, { align: "auto" });
  }, [virtualizer]);
  const total = virtualizer.getTotalSize();
  const footer = maxHeight !== undefined;
  return (
    <div
      ref={ref}
      className={footer ? "shrink-0 overflow-y-auto" : "min-h-0 flex-1 overflow-y-auto"}
      style={footer ? { height: Math.max(0, Math.min(total, maxHeight)) } : undefined}
      data-testid={testId}
    >
      {children}
      {rows.length > 0 && (
        <div style={{ height: total, position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            return (
              <div key={row.key} style={{ position: "absolute", top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${String(vi.start)}px)` }}>
                <SidebarRow row={row} selected={row.key === selectedKey} cursor={row.key === cursorKey} onActivate={onActivate} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The sidebar's thread list: a listbox of four stacked panels. The main list (pinned,
 * waiting, finished, idle) scrolls on its own and takes the remaining height; under it,
 * pinned to the bottom whatever the main list's scroll, the Working footer (expanded by
 * default, up to 40% of the sidebar body), the Snoozed footer (collapsed by default, up to
 * 25%) and the Archived footer (collapsed by default, up to 30%), each its header and then
 * its rows, which scroll inside it once they reach the cap. A footer without threads is
 * not rendered. Keyboard and cmd+N walk one order across the four (buildSections). See
 * docs/notes/archive-threads-2-sidebar.md and snooze-threads-2-sidebar.md.
 */
function SidebarList({ bodyHeight }: { bodyHeight: number }) {
  const { rows, main, headers, footers } = useListRows();
  const listRef = useRef<HTMLDivElement>(null);
  const scrollMain = useRef<ScrollTo>(null);
  const scrollWorking = useRef<ScrollTo>(null);
  const scrollSnoozed = useRef<ScrollTo>(null);
  const scrollArchived = useRef<ScrollTo>(null);
  const selectedKey = useUiStore((s) => (s.selection.kind === "session" ? sessionKey(s.selection.id) : null));
  const cursorKey = useUiStore((s) => s.cursorKey);
  const focusSeq = useUiStore((s) => s.sidebarFocusSeq);
  const loaded = useSessionsStore((s) => s.loaded);
  const unavailable = useSessionsStore((s) => s.availability === "unavailable");
  const streamError = useEventsStore((s) => s.streamError);
  const rowHeight = useRowHeight();
  // The row the context menu is open for (right-clicked), or null.
  const [menuRow, setMenuRow] = useState<SessionRow | null>(null);

  const sizeOf = useCallback(
    (row: Row | undefined) => (row?.kind === "header" ? HEADER_HEIGHT : row?.section === "archived" || row?.section === "snoozed" ? rowHeight : rowHeight + SECOND_LINE),
    [rowHeight],
  );

  const cursorIndex = useMemo(() => {
    const key = cursorKey ?? selectedKey;
    return key ? rows.findIndex((r) => r.key === key && isSessionRow(r)) : -1;
  }, [rows, cursorKey, selectedKey]);
  // The ring is drawn only for a keyboard cursor that is on a shown row.
  const shownCursor = cursorKey !== null && cursorIndex >= 0 ? cursorKey : null;

  useEffect(() => {
    if (focusSeq > 0) listRef.current?.focus();
  }, [focusSeq]);

  const activate = useCallback((row: Row) => {
    if (!isSessionRow(row)) return;
    const ui = useUiStore.getState();
    ui.setCursor(row.key);
    ui.select({ kind: "session", id: row.sessionId }, { focusPrompt: true });
  }, []);

  const panels: Readonly<Record<Panel, { rows: readonly Row[]; scrollTo: RefObject<ScrollTo | null> }>> = {
    main: { rows: main, scrollTo: scrollMain },
    working: { rows: footers.working, scrollTo: scrollWorking },
    snoozed: { rows: footers.snoozed, scrollTo: scrollSnoozed },
    archived: { rows: footers.archived, scrollTo: scrollArchived },
  };

  // The cursor moves in the one order; the panel it lands in scrolls it into view.
  const moveCursor = (i: number) => {
    const row = rows[i];
    if (!row || !isSessionRow(row)) return;
    useUiStore.getState().setCursor(row.key);
    const panel = panels[panelOf(row)];
    const local = panel.rows.indexOf(row);
    if (local >= 0) panel.scrollTo.current?.(local);
  };
  const firstThread = () => stepThread(rows, -1, 1);
  const lastThread = () => stepThread(rows, rows.length, -1);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target !== e.currentTarget) return;
    const row = rows[cursorIndex];
    const ui = useUiStore.getState();
    switch (e.key) {
      case "ArrowDown":
        moveCursor(cursorIndex < 0 ? firstThread() : stepThread(rows, cursorIndex, 1));
        break;
      case "ArrowUp":
        moveCursor(cursorIndex < 0 ? lastThread() : stepThread(rows, cursorIndex, -1));
        break;
      case "Home":
        moveCursor(firstThread());
        break;
      case "End":
        moveCursor(lastThread());
        break;
      case "Enter":
      case " ":
        if (row) activate(row);
        break;
      case "F2":
        if (row?.kind !== "session") return;
        activate(row);
        ui.setRenaming(row.sessionId);
        break;
      case "Escape":
        if (ui.selection.kind === "session") useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Right-click on a thread row opens its menu; anywhere else, none.
  const onContextMenu = (e: React.MouseEvent) => {
    const key = (e.target as Element).closest("[data-row-key]")?.getAttribute("data-row-key");
    const row = rows.find((r) => r.key === key);
    if (!row || !isSessionRow(row)) {
      e.preventDefault();
      setMenuRow(null);
      return;
    }
    setMenuRow(row);
    useUiStore.getState().setCursor(row.key);
  };

  const footer = (section: FooterSection) => {
    const header = headers[section];
    if (header === null) return null;
    // Before the body is measured (0), no cap: the footer fits its rows.
    const cap = bodyHeight > 0 ? Math.max(0, Math.floor(bodyHeight * FOOTER_CAPS[section]) - HEADER_HEIGHT) : Number.POSITIVE_INFINITY;
    return (
      <div key={section} className="flex shrink-0 flex-col" data-testid={`sidebar-${section}`}>
        <div className="shrink-0" style={{ height: HEADER_HEIGHT }}>
          <SidebarRow row={header} selected={false} cursor={false} onActivate={activate} />
        </div>
        <PanelRows
          rows={footers[section]}
          sizeOf={sizeOf}
          selectedKey={selectedKey}
          cursorKey={shownCursor}
          onActivate={activate}
          scrollTo={panels[section].scrollTo}
          maxHeight={cap}
          paddingStart={0}
          paddingEnd={footers[section].length > 0 ? 4 : 0}
          testId={`sidebar-${section}-rows`}
        />
      </div>
    );
  };

  const activeRow = rows[cursorIndex];
  const emptyText = unavailable ? "Threads are unavailable on this daemon." : loaded ? null : streamError ? `Cannot list threads: ${streamError}. Retrying…` : "Loading…";
  return (
    <RowTooltipsEnabled value={menuRow === null}>
      <TooltipProvider delayDuration={500}>
        <ContextMenu
          modal={false}
          onOpenChange={(open) => {
            if (!open) setMenuRow(null);
          }}
        >
          <ContextMenuTrigger asChild>
            <div
              ref={listRef}
              role="listbox"
              aria-label="Threads"
              tabIndex={0}
              data-region="sidebar"
              data-testid="thread-list"
              aria-activedescendant={activeRow ? `row-${activeRow.key}` : undefined}
              className="group flex min-h-0 flex-1 flex-col outline-none"
              onKeyDown={onKeyDown}
              onContextMenu={onContextMenu}
            >
              <PanelRows
                rows={main}
                sizeOf={sizeOf}
                selectedKey={selectedKey}
                cursorKey={shownCursor}
                onActivate={activate}
                scrollTo={scrollMain}
                paddingStart={4}
                paddingEnd={8}
                testId="sidebar-main"
              >
                {rows.length === 0 &&
                  emptyText !== null && (
                    // No threads (once loaded): the list is simply empty.
                    <p className="px-2 py-4 text-xs break-words text-muted-foreground" data-testid="thread-list-empty">
                      {emptyText}
                    </p>
                  )}
              </PanelRows>
              {FOOTERS.map(footer)}
            </div>
          </ContextMenuTrigger>
          {menuRow && <RowMenu id={menuRow.sessionId} />}
        </ContextMenu>
      </TooltipProvider>
    </RowTooltipsEnabled>
  );
}

/** Shown when the daemon has no SessionService (older daemon): everything else still works. */
function SessionsUnavailable() {
  const unavailable = useSessionsStore((s) => s.availability === "unavailable");
  const error = useSessionsStore((s) => s.error);
  if (!unavailable) return null;
  return (
    <p className="shrink-0 border-t border-sidebar-border px-2 py-1.5 text-[11px] text-muted-foreground" data-testid="sessions-unavailable" title={error ?? ""}>
      Threads: service unavailable
    </p>
  );
}

/**
 * The sidebar's share of the title band (components/window/titleBand.ts): the
 * traffic-light gutter, kept empty for the lights, then the app name. The whole band
 * drags the window (Wails runtime, `--wails-draggable`); the controls are in the toolbar
 * below it (SidebarToolbar). See docs/notes/sidebar-toolbar.md.
 *
 * The name is a span, not a heading: every page in the content pane has its own h1. At
 * 16px it fits beside the gutter at SIDEBAR_MIN, so it is not measured; the overflow
 * clip only guards against an unexpected font.
 */
function SidebarBand() {
  const gutter = useUiStore((s) => trafficLightGutter(s.zoom));
  return (
    <div className="flex shrink-0 items-center [--wails-draggable:drag]" style={{ height: TITLE_BAND_HEIGHT }} data-testid="sidebar-band">
      <div className="h-full shrink-0" style={{ width: gutter }} data-testid="traffic-light-gutter" aria-hidden />
      <header className="flex h-full min-w-0 flex-1 items-center pr-3 pl-3">
        <span
          className="min-w-0 overflow-hidden text-base leading-none font-semibold tracking-tight whitespace-nowrap text-sidebar-foreground select-none"
          data-testid="sidebar-app-name"
        >
          Code Foundry
        </span>
      </header>
    </div>
  );
}

export function Sidebar() {
  const visible = useUiStore((s) => s.sidebarVisible);
  const width = useUiStore((s) => s.sidebarWidth);
  if (!visible) return null;
  return <SidebarShown width={width} />;
}

function SidebarShown({ width }: { width: number }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useHeight(bodyRef);
  return (
    <aside className="relative flex shrink-0 flex-col bg-sidebar" style={{ width }} data-testid="sidebar">
      <SidebarBand />
      {/* The content pane floats 8px off the sidebar (App.tsx ContentPane's m-2). Rows run
          to the sidebar's edges, so the same 8px gutter on the left keeps them as far from
          the window edge as from the pane. */}
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col pl-2" data-testid="sidebar-body">
        <SidebarToolbar />
        <SidebarNewThread />
        <nav className="flex shrink-0 flex-col" aria-label="Pages">
          <PullRequestsNav />
          <ProjectsNav />
        </nav>
        <SidebarList bodyHeight={bodyHeight} />
        <SessionsUnavailable />
        <SidebarStatus />
      </div>
      <ResizeHandle />
    </aside>
  );
}
