/**
 * Layouts for the window shell's component tests (docs/notes/shell-11-pane-grid.md): view-model
 * builders and `seedLayout`, which feeds a snapshot to the layout slice as the event source would.
 * Store-free at import (the slice is imported when seeding), so a vi.mock factory may import it.
 */
import type { LayoutNodeView, LayoutSpaceView, LayoutTabView, LayoutView } from "@/api/layout";

export const tab = (id: string, kind: string, thread = "", over: Partial<LayoutTabView> = {}): LayoutTabView => ({
  id,
  kind,
  thread,
  key: `${kind}:${id}`,
  params: {},
  title: "",
  name: "",
  ...over,
});

export const pane = (id: string, tabs: LayoutTabView[], active = tabs[0]?.id ?? ""): LayoutNodeView => ({ t: "pane", id, tabs, active });

export const row = (id: string, kids: LayoutNodeView[], sizes = kids.map(() => 1 / kids.length)): LayoutNodeView => ({ t: "split", id, dir: "row", kids, sizes });

export function space(root: LayoutNodeView | null, focus: string, over: Partial<LayoutSpaceView> = {}): LayoutSpaceView {
  return { id: "sp-a", name: "Main", root, focus, mru: [], drafts: [], ...over };
}

export function layoutOf(spaces: LayoutSpaceView[], rev = 1): LayoutView {
  return { rev, spaces, currentSpaceId: spaces[0]?.id ?? "", defaultSpaceId: spaces[0]?.id ?? "", threads: [] };
}

/** Puts a layout in the slice as a snapshot event. */
export async function seedLayout(l: LayoutView): Promise<void> {
  const { applyLayoutEvent } = await import("@/stores/layout");
  applyLayoutEvent({ kind: "snapshot", rev: l.rev, layout: l, clientId: "" });
}
