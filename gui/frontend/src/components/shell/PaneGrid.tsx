import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { zoomFactor } from "@/lib/zoom";
import { afterRev, runLayoutCommand } from "@/shell/commands";
import { frameRects } from "@/shell/geometry/rects";
import { panesOf, type Frame, type GeoNode } from "@/shell/geometry/types";
import { dragSizes, sizesArg, startDrag, withSizes, type GutterDrag } from "@/shell/resize";
import { reportViewport } from "@/shell/viewport";
import { useCurrentSpaceId, useLayoutStore, useTree, type LayoutState, type TreeNode } from "@/stores/layout";
import { setShellFrame } from "@/stores/shellView";
import { EmptySpace } from "./EmptySpace";
import { Gutter } from "./Gutter";
import { PaneView } from "./PaneView";

/**
 * Each pane's active tab kind, in one string: the pane minimums depend on it and nothing else in
 * the tabs does (rails, which read the rest, are PR 19's), so the grid lays out again only then.
 */
function activeKinds(s: LayoutState, spaceId: string): string {
  return Object.values(s.panes)
    .filter((p) => p.spaceId === spaceId)
    .map((p) => `${p.id}=${s.tabs[p.active]?.kind ?? ""}`)
    .sort()
    .join("\n");
}

/** A space's tree as the geometry reads it: each pane with its active tab's kind. */
function geoOf(n: TreeNode, kinds: ReadonlyMap<string, string>): GeoNode {
  if (n.t === "split") return { t: "split", id: n.id, dir: n.dir, kids: n.kids.map((k) => geoOf(k, kinds)), sizes: n.sizes };
  return { t: "pane", id: n.id, tabs: [{ id: "active", kind: kinds.get(n.id) ?? "" }], active: "active" };
}

/**
 * The current space's panes, tiling the content area (docs/notes/shell-model.md, "Structure"):
 * the layout's tree laid out with pane minimums (shell/geometry), each pane absolutely placed at
 * its rectangle, 12px gutters between them that resize by drag. The area's size goes to the
 * daemon (SetViewport) for placement. A space with no pane shows the composer (EmptySpace).
 * Rails (small windows) are PR 19's: every pane is drawn open for now.
 */
export function PaneGrid() {
  const spaceId = useCurrentSpaceId();
  const tree = useTree(spaceId);
  const kinds = useLayoutStore((s) => activeKinds(s, spaceId));
  const focus = useLayoutStore((s) => s.spaces[spaceId]?.focus ?? "");
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ d: GutterDrag; sizes: number[] } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      reportViewport(r.width, r.height);
      const z = zoomFactor();
      setSize((prev) => (prev && prev.w === r.width / z && prev.h === r.height / z ? prev : { w: r.width / z, h: r.height / z }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  // The tree with its tabs (for the minimums), and the gutter being dragged's sizes on top.
  const stored = useMemo<GeoNode | null>(() => {
    if (!tree) return null;
    const byPane = new Map(kinds.split("\n").map((line) => line.split("=") as [string, string]));
    return geoOf(tree, byPane);
  }, [tree, kinds]);
  const shown = useMemo(() => (drag ? withSizes(stored, drag.d.split, drag.sizes) : stored), [stored, drag]);
  const frame = useMemo<Frame | null>(() => (size && shown ? frameRects(shown, size.w, size.h) : null), [shown, size]);
  useEffect(() => {
    setShellFrame(frame);
  }, [frame]);
  useEffect(
    () => () => {
      setShellFrame(null);
    },
    [],
  );

  const panes = useMemo(() => panesOf(shown).map((p) => p.id), [shown]);
  return (
    <div ref={ref} className="relative min-h-0 min-w-0 flex-1" data-testid="shell-grid" data-space-id={spaceId}>
      {tree === null && <EmptySpace />}
      {frame &&
        panes.map((id) => {
          const r = frame.rects[id];
          return r ? <PaneView key={id} paneId={id} rect={r} focused={id === focus} /> : null;
        })}
      {frame &&
        frame.gutters.map((g) => (
          <Gutter
            key={`${g.split}/${String(g.i)}`}
            gutter={g}
            onStart={() => {
              const d = startDrag(stored, frame, g.split, g.i);
              if (!d) return false;
              setDrag({ d, sizes: [...d.sizes] });
              return true;
            }}
            onDrag={(delta) => {
              setDrag((cur) => (cur ? { d: cur.d, sizes: dragSizes(cur.d, delta) } : cur));
            }}
            onEnd={(moved) => {
              const cur = drag;
              if (!moved || !cur) {
                setDrag(null);
                return;
              }
              // The preview stays until the daemon's commit arrives, so the panes do not jump back.
              void runLayoutCommand("pane.resize", { split: cur.d.split, sizes: sizesArg(cur.sizes) })
                .then((res) => (res ? afterRev(res.rev) : undefined))
                .finally(() => {
                  setDrag(null);
                });
            }}
          />
        ))}
    </div>
  );
}
