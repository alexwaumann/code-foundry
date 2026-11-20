/**
 * The sidebar keyboard cursor's reset rule (stores/ui.ts `cursorKey`): a selection made elsewhere
 * moves the highlight and drops an old cursor. It lives here, beside the stores it reads, rather
 * than in each list that draws the cursor: the expanded list, the rail and each open rail card
 * are lists, mounted together or not at all (docs/notes/shell-reset-rules.md).
 */
import { sidebarAnchor } from "@/lib/inSidebar";
import { draftKey } from "@/lib/shellSections";
import { threadKey } from "@/lib/tree";
import { useLayoutStore, type LayoutState } from "./layout";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";

/** The draft whose composer is the current space's focused tab; "" for none. */
export function focusedDraftOf(s: Pick<LayoutState, "panes" | "tabs" | "spaces" | "currentSpaceId">): string {
  const pane = s.panes[s.spaces[s.currentSpaceId]?.focus ?? ""];
  const tab = s.tabs[pane?.active ?? ""];
  return tab?.kind === "compose" ? (tab.params.draft ?? "") : "";
}

/** The highlighted row's key: the focused thread's anchor row, else the focused draft's; null for neither. */
export function selectedRowKeyOf(anchor: string | null, draft: string): string | null {
  if (anchor !== null) return threadKey(anchor);
  return draft ? draftKey(draft) : null;
}

/** The row the window's focus highlights, read now (listRows.ts useSelectedRowKey, live). */
export function selectedRowKey(): string | null {
  const sel = useUiStore.getState().selection;
  const anchor = sel.kind === "thread" ? sidebarAnchor(useThreadsStore.getState().byId, sel.id) : null;
  return selectedRowKeyOf(anchor, focusedDraftOf(useLayoutStore.getState()));
}

/**
 * The highlighted row as of the last check while a cursor was set; undefined with no cursor.
 * A cursor set now is set against the row highlighted now.
 */
let seen: string | null | undefined;

/** Drops the cursor when the highlighted row changes to a row the cursor is not on. */
function check(): void {
  const ui = useUiStore.getState();
  if (ui.cursorKey === null) {
    seen = undefined;
    return;
  }
  const selected = selectedRowKey();
  if (seen === undefined || selected === seen) {
    seen = selected;
    return;
  }
  seen = selected;
  if (ui.cursorKey !== selected) ui.setCursor(null);
}

useUiStore.subscribe(check);
useThreadsStore.subscribe(check);
useLayoutStore.subscribe(check);
