import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/react/shallow";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { sidebarAnchor } from "@/lib/inSidebar";
import { buildShellSections, draftKey, isPickable, shellRows, type DraftRow, type MainRow, type ShellRow, type ShellThreadRow } from "@/lib/shellSections";
import { isSnoozed } from "@/lib/snooze";
import { FOOTERS, keyedRowCache, threadKey, type FooterSection, type HeaderRow, type Row } from "@/lib/tree";
import { openDraft } from "@/shell/drafts";
import { decodeThreadListKeys, useThreadListKeys } from "@/stores/context";
import { useShownEmberThreadId } from "@/stores/ember";
import { EMBER_ROW_KEY, openEmber } from "@/stores/emberPanel";
import { useEventsStore } from "@/stores/events";
import { selectThreadAndFlag } from "@/stores/flagSurface";
import { useCurrentSpaceId, useLayoutStore } from "@/stores/layout";
import { needsKeyLeave, needsKeyMove, openNeedsPopup } from "@/stores/needs";
import { useCurrentDrafts, useNeedsScope, useThreadSpaces } from "@/stores/shellList";
import { useShellSidebarStore } from "@/stores/shellSidebar";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { HEADER_HEIGHT, ONE_LINE_ROW, QUIET_ROW_GAP, ROW_GAP } from "../rowSizes";
import { RowTooltipsEnabled } from "../rowTooltips";
import { SidebarRow } from "../SidebarRow";
import { DraftRowView, MainHeaderView, ShellThreadRowView } from "./ShellRows";
import { DraftRowMenu, ShellRowMenu } from "./ShellRowMenus";

/**
 * The shell's thread list (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-16-sidebar.md),
 * in place of the classic SidebarList while the shell draws the window: the main list (Needs you,
 * then Active with the space's drafts below its pinned threads) scrolls on its own; the Working,
 * Snoozed and Archived footers sit under it as in the classic list (their caps, headers and
 * Snoozed and Archived rows are the classic ones). Rows are as tall as their content (a title
 * wraps to two lines; a row without a branch line or counts has no third line), so the panels
 * measure them. Keyboard, cursor and the context menu work as in the classic list.
 */

/** The most of the sidebar body a footer (header and rows) takes before its rows scroll. */
const FOOTER_CAPS: Readonly<Record<FooterSection, number>> = { working: 0.4, snoozed: 0.25, archived: 0.3 };

/** A main header's estimated height: its 22px toggle on the bottom, with room above it. */
const MAIN_HEADER_HEIGHT = 28;
/** A thread row's estimate before it is measured: three lines with a one-line title. */
const THREAD_ESTIMATE = 62;

type Panel = "main" | FooterSection;

interface ListRows {
  rows: ShellRow[];
  main: MainRow[];
  headers: Readonly<Record<FooterSection, HeaderRow | null>>;
  footers: Readonly<Record<FooterSection, Row[]>>;
}

function splitFooter(rows: readonly ShellRow[]): [HeaderRow | null, Row[]] {
  const [first, ...rest] = rows as Row[];
  return first?.kind === "header" ? [first, rest] : [null, [...(rows as Row[])]];
}

/** The open thread's id while it is snoozed or archived (its row stays under a collapsed footer), else null. */
function useOpenPutAwayId(): string | null {
  const id = useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : null));
  return useThreadsStore((s) => {
    const t = id === null ? undefined : s.byId[id];
    return t !== undefined && (t.archivedAtMs !== null || isSnoozed(t)) ? t.id : null;
  });
}

function useShellListRows(): ListRows {
  const threadKeys = useThreadListKeys();
  const spaces = useThreadSpaces();
  const drafts = useCurrentDrafts();
  const currentSpaceId = useCurrentSpaceId();
  const needsScope = useNeedsScope();
  const { needsCollapsed, activeCollapsed } = useShellSidebarStore(useShallow((s) => ({ needsCollapsed: s.needsCollapsed, activeCollapsed: s.activeCollapsed })));
  const workingCollapsed = useUiStore((s) => s.workingCollapsed);
  const snoozedCollapsed = useUiStore((s) => s.snoozedCollapsed);
  const archivedCollapsed = useUiStore((s) => s.archivedCollapsed);
  const openThreadId = useOpenPutAwayId();
  const [stable] = useState(() => keyedRowCache<ShellRow>());
  return useMemo(() => {
    const threads = decodeThreadListKeys(threadKeys).map((t, i) => ({ ...t, spaceId: spaces[i] ?? "" }));
    const sec = buildShellSections(threads, {
      currentSpaceId,
      needsScope,
      needsCollapsed,
      activeCollapsed,
      drafts,
      workingCollapsed,
      snoozedCollapsed,
      archivedCollapsed,
      openThreadId,
    });
    const rows = stable(shellRows(sec));
    const headers: Record<FooterSection, HeaderRow | null> = { working: null, snoozed: null, archived: null };
    const footers: Record<FooterSection, Row[]> = { working: [], snoozed: [], archived: [] };
    let at = sec.main.length;
    for (const f of FOOTERS) {
      [headers[f], footers[f]] = splitFooter(rows.slice(at, at + sec[f].length));
      at += sec[f].length;
    }
    return { rows, main: rows.slice(0, sec.main.length) as MainRow[], headers, footers };
  }, [stable, threadKeys, spaces, drafts, currentSpaceId, needsScope, needsCollapsed, activeCollapsed, workingCollapsed, snoozedCollapsed, archivedCollapsed, openThreadId]);
}

/**
 * The row the window's focus highlights: the focused tab's thread (its nearest shown ancestor for
 * a hidden child), or the draft whose composer is the focused tab.
 */
function useSelectedRowKey(): string | null {
  const id = useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : null));
  const anchor = useThreadsStore((s) => (id === null ? null : sidebarAnchor(s.byId, id)));
  const draft = useLayoutStore((s) => {
    const pane = s.panes[s.spaces[s.currentSpaceId]?.focus ?? ""];
    const tab = s.tabs[pane?.active ?? ""];
    return tab?.kind === "compose" ? (tab.params.draft ?? "") : "";
  });
  if (anchor !== null) return threadKey(anchor);
  return draft ? draftKey(draft) : null;
}

function panelOf(row: ShellRow): Panel {
  return row.section === "working" || row.section === "snoozed" || row.section === "archived" ? row.section : "main";
}

function stepPickable(rows: readonly ShellRow[], i: number, dir: 1 | -1): number {
  for (let j = i + dir; j >= 0 && j < rows.length; j += dir) {
    const r = rows[j];
    if (r && isPickable(r)) return j;
  }
  return i;
}

function estimate(row: ShellRow | undefined): number {
  if (!row) return THREAD_ESTIMATE;
  if (row.kind === "header") return row.section === "needs" || row.section === "active" ? MAIN_HEADER_HEIGHT : HEADER_HEIGHT;
  if (row.section === "snoozed" || row.section === "archived") return ONE_LINE_ROW;
  return THREAD_ESTIMATE;
}

type ScrollTo = (index: number) => void;

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
      if (row.section === "snoozed" || row.section === "archived") return <SidebarRow row={row as Row} selected={selected} cursor={cursor} onActivate={onActivate} />;
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
  testId: string;
  children?: React.ReactNode;
}

/** One panel's rows in its own scroll container, virtualized; each row is measured as drawn. */
function PanelRows({ rows, selectedKey, cursorKey, onActivate, scrollTo, maxHeight, gap, paddingStart, paddingEnd, testId, children }: PanelRowsProps) {
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
  const listRef = useRef<HTMLDivElement>(null);
  const scrollMain = useRef<ScrollTo>(null);
  const scrollWorking = useRef<ScrollTo>(null);
  const scrollSnoozed = useRef<ScrollTo>(null);
  const scrollArchived = useRef<ScrollTo>(null);
  const selectedKey = useSelectedRowKey();
  const cursorKey = useUiStore((s) => s.cursorKey);
  const focusSeq = useUiStore((s) => s.sidebarFocusSeq);
  const loaded = useThreadsStore((s) => s.loaded);
  const listError = useThreadsStore((s) => s.error);
  const streamError = useEventsStore((s) => s.streamError);
  const emberId = useShownEmberThreadId();
  const emberSelected = useUiStore((s) => emberId !== "" && s.selection.kind === "thread" && s.selection.id === emberId);
  const [menuRow, setMenuRow] = useState<ShellThreadRow | Row | DraftRow | null>(null);

  const cursorIndex = useMemo(() => {
    const at = (key: string | null) => (key ? rows.findIndex((r) => r.key === key && isPickable(r)) : -1);
    const i = at(cursorKey);
    return i >= 0 ? i : at(selectedKey);
  }, [rows, cursorKey, selectedKey]);
  const shownCursor = cursorKey !== null && rows[cursorIndex]?.key === cursorKey ? cursorKey : null;

  // A selection made elsewhere moves the highlight and drops an old keyboard cursor.
  useEffect(() => {
    const ui = useUiStore.getState();
    if (ui.cursorKey !== null && ui.cursorKey !== selectedKey) ui.setCursor(null);
  }, [selectedKey]);

  useEffect(() => {
    if (focusSeq > 0) listRef.current?.focus();
  }, [focusSeq]);

  /**
   * A thread row adds its tab in the focused pane, or focuses it when it is open in the space
   * (select() through the selection bridge: thread.open); a draft row focuses or reopens its
   * composer (composer.draft.open).
   */
  const activate = useCallback((row: ShellRow) => {
    if (!isPickable(row)) return;
    const ui = useUiStore.getState();
    ui.setCursor(row.key);
    if (row.kind === "draft") {
      void openDraft(row.draftId);
      return;
    }
    selectThreadAndFlag(row.threadId);
  }, []);

  const panels: Readonly<Record<Panel, { rows: readonly ShellRow[]; scrollTo: RefObject<ScrollTo | null> }>> = {
    main: { rows: main, scrollTo: scrollMain },
    working: { rows: footers.working, scrollTo: scrollWorking },
    snoozed: { rows: footers.snoozed, scrollTo: scrollSnoozed },
    archived: { rows: footers.archived, scrollTo: scrollArchived },
  };

  const moveCursor = (i: number) => {
    const row = rows[i];
    if (!row || !isPickable(row)) return;
    needsKeyMove();
    useUiStore.getState().setCursor(row.key);
    const panel = panels[panelOf(row)];
    const local = panel.rows.indexOf(row);
    if (local >= 0) panel.scrollTo.current?.(local);
  };
  const first = () => stepPickable(rows, -1, 1);
  const last = () => stepPickable(rows, rows.length, -1);
  const onEmber = emberId !== "" && (cursorKey === EMBER_ROW_KEY || (cursorIndex < 0 && emberSelected));
  const toEmber = () => {
    useUiStore.getState().setCursor(EMBER_ROW_KEY);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target !== e.currentTarget) return;
    const row = onEmber ? undefined : rows[cursorIndex];
    const ui = useUiStore.getState();
    switch (e.key) {
      case "ArrowDown":
        moveCursor(cursorIndex < 0 || onEmber ? first() : stepPickable(rows, cursorIndex, 1));
        break;
      case "ArrowUp":
        if (onEmber) break;
        if (emberId !== "" && cursorIndex >= 0 && stepPickable(rows, cursorIndex, -1) === cursorIndex) toEmber();
        else moveCursor(cursorIndex < 0 ? last() : stepPickable(rows, cursorIndex, -1));
        break;
      case "Home":
        if (emberId !== "") toEmber();
        else moveCursor(first());
        break;
      case "End":
        moveCursor(last());
        break;
      case "Enter":
      case " ":
        if (onEmber) {
          ui.setCursor(EMBER_ROW_KEY);
          openEmber(emberId);
        } else if (row?.kind === "thread" && row.section === "needs") {
          // A Needs you row's ask is answered in its popup (the card cannot take the keyboard).
          openNeedsPopup(row.threadId, `sidebar:${row.threadId}`);
        } else if (row) activate(row);
        break;
      case "F2":
        if (row?.kind !== "thread") return;
        activate(row);
        ui.setRenaming(row.threadId);
        break;
      case "Escape":
        if (ui.selection.kind === "thread") useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const key = (e.target as Element).closest("[data-row-key]")?.getAttribute("data-row-key");
    const row = rows.find((r) => r.key === key);
    if (!row || !isPickable(row)) {
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
    const cap = bodyHeight > 0 ? Math.max(0, Math.floor(bodyHeight * FOOTER_CAPS[section]) - HEADER_HEIGHT) : Number.POSITIVE_INFINITY;
    return (
      <div key={section} className="flex shrink-0 flex-col" data-testid={`sidebar-${section}`}>
        <div className="shrink-0" style={{ height: HEADER_HEIGHT }}>
          <SidebarRow row={header} selected={false} cursor={false} onActivate={activate} />
        </div>
        <PanelRows
          rows={footers[section]}
          selectedKey={selectedKey}
          cursorKey={shownCursor}
          onActivate={activate}
          scrollTo={panels[section].scrollTo}
          maxHeight={cap}
          gap={section === "working" ? ROW_GAP : QUIET_ROW_GAP}
          paddingStart={0}
          paddingEnd={footers[section].length > 0 ? 4 : 0}
          testId={`sidebar-${section}-rows`}
        />
      </div>
    );
  };

  const activeRow = onEmber ? undefined : rows[cursorIndex];
  const loadError = streamError ?? listError;
  const emptyText = loaded ? null : loadError ? `Cannot list threads: ${loadError}. Retrying…` : "Loading…";
  return (
    <RowTooltipsEnabled value={menuRow === null}>
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
            data-shell-list
            aria-activedescendant={onEmber ? `row-${EMBER_ROW_KEY}` : activeRow ? `row-${activeRow.key}` : undefined}
            className="group flex min-h-0 flex-1 flex-col outline-none"
            onKeyDown={onKeyDown}
            onBlur={needsKeyLeave}
            onPointerDown={needsKeyLeave}
            onContextMenu={onContextMenu}
          >
            <PanelRows
              rows={main}
              selectedKey={selectedKey}
              cursorKey={shownCursor}
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
          </div>
        </ContextMenuTrigger>
        {menuRow?.kind === "thread" && <ShellRowMenu id={menuRow.threadId} />}
        {menuRow?.kind === "draft" && <DraftRowMenu id={menuRow.draftId} />}
      </ContextMenu>
    </RowTooltipsEnabled>
  );
}
