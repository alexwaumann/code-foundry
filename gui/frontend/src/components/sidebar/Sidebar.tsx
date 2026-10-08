import { useCallback, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BellRing } from "lucide-react";
import { PullRequestsNav } from "@/components/prs/PullRequestsPage";
import { jumpToAttention } from "@/keys/bindings";
import { buildRows, isLeaf, type Row } from "@/lib/tree";
import {
  decodeRepoKeys,
  decodeSessionKeys,
  decodeTerminalKeys,
  useRepoStructureKeys,
  useSessionPlacementKeys,
  useTerminalPlacementKeys,
} from "@/stores/context";
import { useEventsStore } from "@/stores/events";
import { useReposStore } from "@/stores/repos";
import { useAttentionCount, useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { rowSelection, selectionKey } from "./selection";
import { ResizeHandle } from "./ResizeHandle";
import { ROW_HEIGHT, SidebarRow } from "./SidebarRow";

/** Index of the nearest row above `i` with a smaller depth (the parent). */
function parentIndex(rows: readonly Row[], i: number): number {
  const depth = rows[i]?.depth ?? 0;
  for (let j = i - 1; j >= 0; j--) if ((rows[j]?.depth ?? 0) < depth) return j;
  return -1;
}

function useRows(): Row[] {
  const repoKeys = useRepoStructureKeys();
  const termKeys = useTerminalPlacementKeys();
  const sessionKeys = useSessionPlacementKeys();
  const collapsed = useUiStore((s) => s.collapsed);
  return useMemo(
    () => buildRows(decodeRepoKeys(repoKeys), decodeTerminalKeys(termKeys), collapsed, decodeSessionKeys(sessionKeys)),
    [repoKeys, termKeys, sessionKeys, collapsed],
  );
}

function SidebarTree() {
  const rows = useRows();
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedKey = useUiStore((s) => selectionKey(s.selection));
  const cursorKey = useUiStore((s) => s.cursorKey);
  const focusSeq = useUiStore((s) => s.sidebarFocusSeq);
  const loaded = useReposStore((s) => s.loaded);
  const streamError = useEventsStore((s) => s.streamError);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    paddingStart: 4,
    paddingEnd: 8,
  });

  const cursorIndex = useMemo(() => {
    const key = cursorKey ?? selectedKey;
    const i = key ? rows.findIndex((r) => r.key === key) : -1;
    return i;
  }, [rows, cursorKey, selectedKey]);

  useEffect(() => {
    if (focusSeq > 0) scrollRef.current?.focus();
  }, [focusSeq]);

  const activate = useCallback((row: Row, how: "click" | "toggle" | "enter") => {
    const ui = useUiStore.getState();
    ui.setCursor(row.key);
    if (how === "toggle" || row.kind === "group") {
      if (!isLeaf(row)) ui.toggleCollapsed(row.key);
      return;
    }
    const sel = rowSelection(row);
    if (sel) ui.select(sel, { focusTerminal: isLeaf(row) });
  }, []);

  const moveCursor = (i: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!row) return;
    useUiStore.getState().setCursor(row.key);
    virtualizer.scrollToIndex(rows.indexOf(row), { align: "auto" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target !== e.currentTarget) return;
    const row = rows[cursorIndex];
    const ui = useUiStore.getState();
    switch (e.key) {
      case "ArrowDown":
        moveCursor(cursorIndex < 0 ? 0 : cursorIndex + 1);
        break;
      case "ArrowUp":
        moveCursor(cursorIndex < 0 ? rows.length - 1 : cursorIndex - 1);
        break;
      case "Home":
        moveCursor(0);
        break;
      case "End":
        moveCursor(rows.length - 1);
        break;
      case "Enter":
      case " ":
        if (row) activate(row, "enter");
        break;
      case "ArrowRight":
        if (!row || isLeaf(row)) break;
        if (!row.expanded) ui.toggleCollapsed(row.key, false);
        else if (row.hasChildren) moveCursor(cursorIndex + 1);
        break;
      case "ArrowLeft":
        if (row && !isLeaf(row) && row.expanded && row.hasChildren) ui.toggleCollapsed(row.key, true);
        else moveCursor(parentIndex(rows, cursorIndex));
        break;
      case "F2":
        if (row?.kind !== "session") return;
        activate(row, "click");
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

  const activeRow = rows[cursorIndex];
  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label="Repositories, sessions and terminals"
      tabIndex={0}
      data-region="sidebar"
      aria-activedescendant={activeRow ? `row-${activeRow.key}` : undefined}
      className="group min-h-0 flex-1 overflow-y-auto px-1.5 outline-none"
      onKeyDown={onKeyDown}
    >
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-xs break-words text-muted-foreground">
          {loaded ? "No repositories registered." : streamError ? `Cannot list repositories: ${streamError}. Retrying…` : "Loading…"}
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
  );
}

/** Count of sessions waiting on the user; click (or cmd+shift+a) jumps to the next one. */
function AttentionBadge() {
  const count = useAttentionCount();
  if (count === 0) return null;
  const label = `${String(count)} ${count === 1 ? "session needs" : "sessions need"} attention`;
  return (
    <button
      type="button"
      tabIndex={-1}
      title={`${label} (⌘⇧A)`}
      aria-label={label}
      data-testid="attention-badge"
      className="flex h-5 items-center gap-1 rounded-full bg-amber-400/15 px-2 font-semibold tracking-normal text-amber-300 tabular-nums normal-case hover:bg-amber-400/25"
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
      Sessions: service unavailable
    </p>
  );
}

export function Sidebar() {
  const visible = useUiStore((s) => s.sidebarVisible);
  const width = useUiStore((s) => s.sidebarWidth);
  const repoCount = useReposStore((s) => s.order.length);
  if (!visible) return null;
  return (
    <aside className="relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar" style={{ width }} data-testid="sidebar">
      <PullRequestsNav />
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 px-3 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        <span>Repositories</span>
        <span className="flex items-center gap-2">
          <AttentionBadge />
          <span className="tabular-nums">{repoCount > 0 ? repoCount : ""}</span>
        </span>
      </header>
      <SidebarTree />
      <SessionsUnavailable />
      <ResizeHandle />
    </aside>
  );
}
