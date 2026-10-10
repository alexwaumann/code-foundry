import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BellRing, SquarePen } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ProjectsNav } from "@/components/projects/ProjectsPage";
import { PullRequestsNav } from "@/components/prs/PullRequestsPage";
import { TITLE_BAND_HEIGHT, TRAFFIC_LIGHT_GUTTER } from "@/components/window/titleBand";
import { jumpToAttention } from "@/keys/bindings";
import { buildRows, isLeaf, type LeafRow, type Row } from "@/lib/tree";
import { decodeSessionListKeys, decodeTerminalKeys, useSessionListKeys, useTerminalPlacementKeys } from "@/stores/context";
import { useEventsStore } from "@/stores/events";
import { useAttentionCount, useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { useRowHeight } from "@/stores/settings";
import { RowMenu } from "./RowMenu";
import { rowSelection, selectionKey } from "./selection";
import { ResizeHandle } from "./ResizeHandle";
import { SidebarRow } from "./SidebarRow";
import { SidebarStatus } from "./SidebarStatus";

/** Section header height; thread and terminal rows are two lines (rowHeight + this). */
const HEADER_HEIGHT = 26;
const SECOND_LINE = 15;

function useRows(): Row[] {
  const sessionKeys = useSessionListKeys();
  const termKeys = useTerminalPlacementKeys();
  return useMemo(() => buildRows(decodeSessionListKeys(sessionKeys), decodeTerminalKeys(termKeys)), [sessionKeys, termKeys]);
}

/** Index of the next leaf row from i in direction dir (skipping headers); i itself when none. */
function stepLeaf(rows: readonly Row[], i: number, dir: 1 | -1): number {
  for (let j = i + dir; j >= 0 && j < rows.length; j += dir) if (rows[j] && isLeaf(rows[j] as Row)) return j;
  return i;
}

function SidebarList() {
  const rows = useRows();
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedKey = useUiStore((s) => selectionKey(s.selection));
  const cursorKey = useUiStore((s) => s.cursorKey);
  const focusSeq = useUiStore((s) => s.sidebarFocusSeq);
  const loaded = useSessionsStore((s) => s.loaded);
  const unavailable = useSessionsStore((s) => s.availability === "unavailable");
  const streamError = useEventsStore((s) => s.streamError);
  const rowHeight = useRowHeight();
  const leafHeight = rowHeight + SECOND_LINE;
  // The row the context menu is open for (right-clicked), or null.
  const [menuRow, setMenuRow] = useState<LeafRow | null>(null);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "header" ? HEADER_HEIGHT : leafHeight),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 10,
    paddingStart: 4,
    paddingEnd: 8,
  });

  // appearance.density changes the row height, and sections come and go; drop the cached sizes.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, leafHeight, rows]);

  const cursorIndex = useMemo(() => {
    const key = cursorKey ?? selectedKey;
    return key ? rows.findIndex((r) => r.key === key && isLeaf(r)) : -1;
  }, [rows, cursorKey, selectedKey]);

  useEffect(() => {
    if (focusSeq > 0) scrollRef.current?.focus();
  }, [focusSeq]);

  const activate = useCallback((row: Row) => {
    const sel = rowSelection(row);
    if (!sel) return;
    const ui = useUiStore.getState();
    ui.setCursor(row.key);
    ui.select(sel, { focusTerminal: true });
  }, []);

  const moveCursor = (i: number) => {
    const row = rows[i];
    if (!row || !isLeaf(row)) return;
    useUiStore.getState().setCursor(row.key);
    virtualizer.scrollToIndex(i, { align: "auto" });
  };
  const firstLeaf = () => stepLeaf(rows, -1, 1);
  const lastLeaf = () => stepLeaf(rows, rows.length, -1);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target !== e.currentTarget) return;
    const row = rows[cursorIndex];
    const ui = useUiStore.getState();
    switch (e.key) {
      case "ArrowDown":
        moveCursor(cursorIndex < 0 ? firstLeaf() : stepLeaf(rows, cursorIndex, 1));
        break;
      case "ArrowUp":
        moveCursor(cursorIndex < 0 ? lastLeaf() : stepLeaf(rows, cursorIndex, -1));
        break;
      case "Home":
        moveCursor(firstLeaf());
        break;
      case "End":
        moveCursor(lastLeaf());
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
        if (ui.selection.kind === "terminal" || ui.selection.kind === "session") useUiStore.setState((s) => ({ terminalFocusSeq: s.terminalFocusSeq + 1 }));
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Right-click on a thread or terminal row opens its menu; anywhere else, none.
  const onContextMenu = (e: React.MouseEvent) => {
    const key = (e.target as Element).closest("[data-row-key]")?.getAttribute("data-row-key");
    const row = rows.find((r) => r.key === key);
    if (!row || !isLeaf(row)) {
      e.preventDefault();
      setMenuRow(null);
      return;
    }
    setMenuRow(row);
    useUiStore.getState().setCursor(row.key);
  };

  const activeRow = rows[cursorIndex];
  return (
    <ContextMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) setMenuRow(null);
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          ref={scrollRef}
          role="listbox"
          aria-label="Threads and terminals"
          tabIndex={0}
          data-region="sidebar"
          data-testid="thread-list"
          aria-activedescendant={activeRow ? `row-${activeRow.key}` : undefined}
          className="group min-h-0 flex-1 overflow-y-auto px-1.5 outline-none"
          onKeyDown={onKeyDown}
          onContextMenu={onContextMenu}
        >
          {rows.length === 0 ? (
            <p className="px-3 py-4 text-xs break-words text-muted-foreground" data-testid="thread-list-empty">
              {unavailable
                ? "Threads are unavailable on this daemon."
                : loaded
                  ? "No threads yet. Start one with New thread; projects and their worktrees are on the Projects page."
                  : streamError
                    ? `Cannot list threads: ${streamError}. Retrying…`
                    : "Loading…"}
            </p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const row = rows[vi.index];
                if (!row) return null;
                return (
                  <div key={row.key} style={{ position: "absolute", top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${String(vi.start)}px)` }}>
                    <SidebarRow row={row} selected={row.key === selectedKey} cursor={vi.index === cursorIndex && cursorKey !== null} onActivate={activate} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      {menuRow && <RowMenu row={menuRow} />}
    </ContextMenu>
  );
}

/** Count of sessions waiting on the user; click jumps to the next one. */
function AttentionBadge() {
  const count = useAttentionCount();
  if (count === 0) return null;
  const label = `${String(count)} ${count === 1 ? "thread needs" : "threads need"} attention`;
  return (
    <button
      type="button"
      tabIndex={-1}
      title={label}
      aria-label={label}
      data-testid="attention-badge"
      className="flex h-5 items-center gap-1 rounded-full bg-amber-400/15 px-2 text-[11px] font-semibold text-amber-300 tabular-nums hover:bg-amber-400/25"
      onClick={() => {
        jumpToAttention();
      }}
    >
      <BellRing className="size-3" aria-hidden />
      {count}
    </button>
  );
}

/** Shown when the daemon has no SessionService (older daemon): everything else still works. */
function SessionsUnavailable() {
  const unavailable = useSessionsStore((s) => s.availability === "unavailable");
  const error = useSessionsStore((s) => s.error);
  if (!unavailable) return null;
  return (
    <p className="shrink-0 border-t border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="sessions-unavailable" title={error ?? ""}>
      Threads: service unavailable
    </p>
  );
}

/**
 * The sidebar's share of the title band (components/window/titleBand.ts): the
 * traffic-light gutter, kept empty for the lights, then the app name and the controls
 * (attention badge, New thread). The whole band drags the window (Wails runtime,
 * `--wails-draggable`) except its controls. See docs/notes/sidebar-title-band.md.
 */
function SidebarBand() {
  return (
    <div className="flex shrink-0 items-center [--wails-draggable:drag]" style={{ height: TITLE_BAND_HEIGHT }} data-testid="sidebar-band">
      <div className="h-full shrink-0" style={{ width: TRAFFIC_LIGHT_GUTTER }} data-testid="traffic-light-gutter" aria-hidden />
      <header className="flex h-full min-w-0 flex-1 items-center justify-between gap-2 pr-3 pl-3">
        <h1 className="min-w-0 truncate text-[13px] leading-none font-semibold tracking-tight text-foreground select-none">Code Foundry</h1>
        <span className="flex shrink-0 items-center gap-2 [--wails-draggable:no-drag]" data-testid="sidebar-band-controls">
          <AttentionBadge />
          {/* New thread (the project picker), as session.new from the palette. New terminal is palette, ⌘T and row menu only. */}
          <span className="-mr-1.5 flex items-center">
            <CommandButton command="session.new" icon={SquarePen} whenUnavailable="disable" data-testid="sidebar-new-session" />
          </span>
        </span>
      </header>
    </div>
  );
}

export function Sidebar() {
  const visible = useUiStore((s) => s.sidebarVisible);
  const width = useUiStore((s) => s.sidebarWidth);
  if (!visible) return null;
  return (
    <aside className="relative flex shrink-0 flex-col bg-sidebar" style={{ width }} data-testid="sidebar">
      <SidebarBand />
      <nav className="flex shrink-0 flex-col" aria-label="Pages">
        <PullRequestsNav />
        <ProjectsNav />
      </nav>
      <SidebarList />
      <SessionsUnavailable />
      <SidebarStatus />
      <ResizeHandle />
    </aside>
  );
}
