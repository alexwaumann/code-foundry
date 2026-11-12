/**
 * Whether each pane's active tab shows its whole name (shell/geometry/tabFit: "full") or is cut
 * short or icon-only. The strip measures it (components/shell/PaneTabStrip.tsx); a thread's
 * header names the thread only while its tab does not (components/thread/ThreadHeader.tsx), so
 * the name is never on screen twice and never missing. Window-only state.
 */
import { create } from "zustand";

export const useTabCut = create<{ cut: Readonly<Record<string, boolean>> }>()(() => ({ cut: {} }));

/** The strip of `paneId` says whether its active tab's name is cut. */
export function setTabCut(paneId: string, cut: boolean): void {
  if ((useTabCut.getState().cut[paneId] ?? false) === cut) return;
  useTabCut.setState((s) => ({ cut: { ...s.cut, [paneId]: cut } }));
}

/** A strip went away: forget its pane. */
export function dropTabCut(paneId: string): void {
  if (!(paneId in useTabCut.getState().cut)) return;
  useTabCut.setState((s) => {
    const { [paneId]: _gone, ...rest } = s.cut;
    return { cut: rest };
  });
}

/** Whether the pane's active tab name is cut short or hidden ("" outside the shell: false). */
export function usePaneTabCut(paneId: string): boolean {
  return useTabCut((s) => s.cut[paneId] ?? false);
}
