/**
 * Draws the current space's panes for component tests, the way the window does (the real
 * PaneView: each pane's tab strip and its active tab's body), without the grid's geometry
 * (jsdom has no layout): every pane at a fixed rectangle. Pair with src/test/fakeLayout.ts, which
 * answers the ops the surfaces send. Imports stores: load it after the vi.mock calls (await import).
 */
import { useShallow } from "zustand/react/shallow";
import { PaneView } from "@/components/shell/PaneView";
import { useLayoutStore } from "@/stores/layout";
import { currentPanes } from "./layoutTabs";

const RECT = { x: 0, y: 0, w: 900, h: 700, rail: false };

/** Every pane of the current space, the focused one marked focused. */
export function ShellPanes() {
  const panes = useLayoutStore(useShallow((s) => currentPanes(s)));
  const focus = useLayoutStore((s) => s.spaces[s.currentSpaceId]?.focus ?? "");
  return (
    <>
      {panes.map((id) => (
        <div key={id} data-testid="test-pane" data-pane={id}>
          <PaneView paneId={id} rect={RECT} focused={id === focus} />
        </div>
      ))}
    </>
  );
}
