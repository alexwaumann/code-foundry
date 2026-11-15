/**
 * What a sidebar row's thread drags as, and where it may land (docs/notes/shell-16-sidebar.md,
 * docs/notes/preview-tabs-2-row-drag.md). Every row drags, whatever its section: Needs you,
 * Active, Working, Snoozed, Archived.
 *
 * A thread lives in one space (its record in the layout, else the default space), except an
 * archived one: it lives in no space until it is opened, and `thread.open` puts it in the space
 * it opens in (the daemon's OpenThread `Archived`). So an archived thread with no tab open
 * drops in the current space's grid wherever its record says it was, and no space tab takes it
 * (it belongs to none). Once its tab is open it is like any other: the row drags as that tab
 * in its space, and a space tab moves the tab there (`thread.space.move`).
 */
import { spaceOfThread, type LayoutState, type TabEntry } from "@/stores/layout";
import type { DragSource } from "./targets";

type Layout = Pick<LayoutState, "tabs" | "panes" | "threads" | "defaultSpaceId">;

/** The thread's own tab, in whichever space it is open; undefined when it is not open. */
export function openThreadTab(s: Pick<LayoutState, "tabs">, thread: string): TabEntry | undefined {
  return Object.values(s.tabs).find((t) => t.kind === "thread" && t.thread === thread);
}

/**
 * What a row's drag moves: a thread whose tab is open in the current space drags as that tab
 * (a move, never a second tab); any other stays a thread (its drop opens it).
 */
export function rowDragSource(src: DragSource | null, s: Layout, spaceId: string): DragSource | null {
  if (src?.kind !== "thread") return src;
  const tab = openThreadTab(s, src.thread);
  if (!tab || s.panes[tab.paneId]?.spaceId !== spaceId) return src;
  return { kind: "tab", tab: tab.id, pane: tab.paneId };
}

/**
 * Whether a thread dragged from the sidebar may drop in the current space's grid: one that lives
 * there, or an archived one with no tab open (it lives in no space; the drop puts it here). A
 * thread of another space (a Needs you row, an archived thread open there) goes to a space tab only.
 */
export function threadDropsInGrid(src: Extract<DragSource, { kind: "thread" }>, s: Layout, spaceId: string): boolean {
  if (src.archived && !openThreadTab(s, src.thread)) return true;
  return spaceOfThread(s, src.thread) === spaceId;
}
