/**
 * The current space's panes and tabs as the layout slice has them, for component tests
 * (src/test/shellPanes.tsx draws them). Imports stores: load it after the vi.mock calls.
 */
import { useLayoutStore, type LayoutState } from "@/stores/layout";

/** The current space's panes, in layout order. */
export function currentPanes(s: Pick<LayoutState, "currentSpaceId" | "trees">): string[] {
  const out: string[] = [];
  const walk = (n: LayoutState["trees"][string] | undefined): void => {
    if (!n) return;
    if (n.t === "pane") out.push(n.id);
    else n.kids.forEach(walk);
  };
  walk(s.trees[s.currentSpaceId]);
  return out;
}

/** Every tab of the current space, pane by pane: `kind` and title as the layout has them. */
export function layoutTabs(): { pane: string; id: string; kind: string; thread: string; title: string; params: Readonly<Record<string, string>>; active: boolean }[] {
  const s = useLayoutStore.getState();
  return currentPanes(s).flatMap((p) => {
    const pane = s.panes[p];
    return (pane?.tabIds ?? []).flatMap((id) => {
      const t = s.tabs[id];
      return t ? [{ pane: p, id, kind: t.kind, thread: t.thread, title: t.name || t.title, params: t.params, active: pane?.active === id }] : [];
    });
  });
}
