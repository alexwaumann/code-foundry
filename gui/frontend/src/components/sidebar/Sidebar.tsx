import { useCallback, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { buildRows, type Row } from "@/lib/tree";
import { decodeRepoKeys, decodeTerminalKeys, useRepoStructureKeys, useTerminalPlacementKeys } from "@/stores/context";
import { useReposStore } from "@/stores/repos";
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
  const collapsed = useUiStore((s) => s.collapsed);
  return useMemo(() => buildRows(decodeRepoKeys(repoKeys), decodeTerminalKeys(termKeys), collapsed), [repoKeys, termKeys, collapsed]);
}

function SidebarTree() {
  const rows = useRows();
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedKey = useUiStore((s) => selectionKey(s.selection));
  const cursorKey = useUiStore((s) => s.cursorKey);
  const focusSeq = useUiStore((s) => s.sidebarFocusSeq);
  const loaded = useReposStore((s) => s.loaded);

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
      if (row.kind !== "terminal") ui.toggleCollapsed(row.key);
      return;
    }
    const sel = rowSelection(row);
    if (sel) ui.select(sel, { focusTerminal: row.kind === "terminal" });
  }, []);

  const moveCursor = (i: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!row) return;
    useUiStore.getState().setCursor(row.key);
    virtualizer.scrollToIndex(rows.indexOf(row), { align: "auto" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
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
        if (!row || row.kind === "terminal") break;
        if (!row.expanded) ui.toggleCollapsed(row.key, false);
        else if (row.hasChildren) moveCursor(cursorIndex + 1);
        break;
      case "ArrowLeft":
        if (row && row.kind !== "terminal" && row.expanded && row.hasChildren) ui.toggleCollapsed(row.key, true);
        else moveCursor(parentIndex(rows, cursorIndex));
        break;
      case "Escape":
        if (ui.selection.kind === "terminal") useUiStore.setState((s) => ({ terminalFocusSeq: s.terminalFocusSeq + 1 }));
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
      aria-label="Repositories and terminals"
      tabIndex={0}
      data-region="sidebar"
      aria-activedescendant={activeRow ? `row-${activeRow.key}` : undefined}
      className="group min-h-0 flex-1 overflow-y-auto px-1.5 outline-none"
      onKeyDown={onKeyDown}
    >
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">{loaded ? "No repositories registered." : "Loading…"}</p>
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

export function Sidebar() {
  const visible = useUiStore((s) => s.sidebarVisible);
  const width = useUiStore((s) => s.sidebarWidth);
  const repoCount = useReposStore((s) => s.order.length);
  if (!visible) return null;
  return (
    <aside className="relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar" style={{ width }} data-testid="sidebar">
      <header className="flex h-9 shrink-0 items-center justify-between px-3 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        <span>Repositories</span>
        <span className="tabular-nums">{repoCount > 0 ? repoCount : ""}</span>
      </header>
      <SidebarTree />
      <ResizeHandle />
    </aside>
  );
}
