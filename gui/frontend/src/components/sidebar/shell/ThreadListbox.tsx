import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { isPickable, type DraftRow, type ShellRow, type ShellThreadRow } from "@/lib/shellSections";
import { cn } from "@/lib/utils";
import { openDraft } from "@/shell/drafts";
import { useShownEmberThreadId } from "@/stores/ember";
import { EMBER_ROW_KEY, openEmber } from "@/stores/emberPanel";
import { openThread } from "@/stores/openThread";
import { needsKeyLeave, needsKeyMove, openNeedsPopup } from "@/stores/needs";
import { renameInSidebar, useUiStore } from "@/stores/ui";
import type { Row } from "@/lib/tree";
import { RowTooltipsEnabled } from "../rowTooltips";
import { useSelectedRowKey } from "./listRows";
import { DraftRowMenu, ShellRowMenu } from "./ShellRowMenus";

/**
 * What a presentation of the thread list draws its rows with: the highlighted row, the keyboard
 * cursor's row (null while the cursor is not on a row the list has), and what a row's click does.
 */
export interface ListboxRows {
  selectedKey: string | null;
  cursorKey: string | null;
  activate: (row: ShellRow) => void;
}

/** The last sidebarFocusSeq a list acted on, whichever of the two presentations was drawn. */
let handledFocusSeq = 0;

function stepPickable(rows: readonly ShellRow[], i: number, dir: 1 | -1): number {
  for (let j = i + dir; j >= 0 && j < rows.length; j += dir) {
    const r = rows[j];
    if (r && isPickable(r)) return j;
  }
  return i;
}

interface ThreadListboxProps {
  /** Every row the keys walk, in order. */
  rows: readonly ShellRow[];
  /** Brings a row the cursor moved to into view in its own scroll container. */
  scrollToRow: (row: ShellRow) => void;
  testId: string;
  /** The listbox's accessible name ("Threads"; a rail card's section). */
  label?: string;
  className?: string;
  /**
   * Whether the window's requests for the list's keyboard (sidebarFocusSeq) reach this one. The
   * rail's section cards list rows too, but the request is the rail's own list's.
   */
  claimsFocus?: boolean;
  /** Told as a row's context menu opens and closes (a rail card stays open while it is up). */
  onMenuOpenChange?: (open: boolean) => void;
  children: (list: ListboxRows) => ReactNode;
}

/**
 * The behaviour the sidebar's thread list has whatever it looks like (docs/notes/sidebar-rail.md):
 * the listbox the window's keys reach (sidebarFocusSeq), its keyboard cursor (arrows, Home and End
 * reaching Ember's row, Enter, F2, Escape), a row's click (activate), and the context menu of the
 * row under a right click (ShellRowMenu, DraftRowMenu), with the rows' hover cards shut while it is
 * open. The expanded list (ShellSidebarList) and the collapsed rail (sidebar/rail) draw the rows,
 * and so do the rail's Working, Snoozed and Archived cards (rail/RailSectionCard.tsx).
 */
export function ThreadListbox({ rows, scrollToRow, testId, label = "Threads", className, claimsFocus = true, onMenuOpenChange, children }: ThreadListboxProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedKey = useSelectedRowKey();
  const cursorKey = useUiStore((s) => s.cursorKey);
  const focusSeq = useUiStore((s) => s.sidebarFocusSeq);
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

  // Each request takes the keyboard once: a list mounted later (the rail giving way to the
  // expanded list for a rename) must not take it again from the field that has it.
  useEffect(() => {
    if (!claimsFocus || focusSeq <= handledFocusSeq) return;
    handledFocusSeq = focusSeq;
    listRef.current?.focus();
  }, [focusSeq, claimsFocus]);

  /**
   * A thread row adds its tab in the focused pane, or focuses it when it is open in the space
   * (select() through the selection bridge: thread.open; an Archived or Snoozed row's with
   * --preview); a draft row focuses or reopens its composer (composer.draft.open).
   */
  const activate = useCallback((row: ShellRow) => {
    if (!isPickable(row)) return;
    const ui = useUiStore.getState();
    ui.setCursor(row.key);
    if (row.kind === "draft") {
      void openDraft(row.draftId);
      return;
    }
    // An Archived or Snoozed row opens the thread as the space's preview tab (shell-model.md, "Preview tabs").
    openThread(row.threadId, { preview: row.section === "archived" || row.section === "snoozed" });
  }, []);

  const moveCursor = (i: number) => {
    const row = rows[i];
    if (!row || !isPickable(row)) return;
    needsKeyMove();
    useUiStore.getState().setCursor(row.key);
    scrollToRow(row);
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
        // On the rail, the rename field's row is the expanded list's.
        renameInSidebar(row.threadId);
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
    onMenuOpenChange?.(true);
    useUiStore.getState().setCursor(row.key);
  };

  const activeRow = onEmber ? undefined : rows[cursorIndex];
  return (
    <RowTooltipsEnabled value={menuRow === null}>
      <ContextMenu
        modal={false}
        onOpenChange={(open) => {
          if (open) return;
          setMenuRow(null);
          onMenuOpenChange?.(false);
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            ref={listRef}
            role="listbox"
            aria-label={label}
            tabIndex={0}
            data-region="sidebar"
            data-testid={testId}
            data-shell-list
            aria-activedescendant={onEmber ? `row-${EMBER_ROW_KEY}` : activeRow ? `row-${activeRow.key}` : undefined}
            className={cn("group flex min-h-0 flex-1 flex-col outline-none", className)}
            onKeyDown={onKeyDown}
            onBlur={needsKeyLeave}
            onPointerDown={needsKeyLeave}
            onContextMenu={onContextMenu}
          >
            {children({ selectedKey, cursorKey: shownCursor, activate })}
          </div>
        </ContextMenuTrigger>
        {menuRow?.kind === "thread" && <ShellRowMenu id={menuRow.threadId} />}
        {menuRow?.kind === "draft" && <DraftRowMenu id={menuRow.draftId} />}
      </ContextMenu>
    </RowTooltipsEnabled>
  );
}
