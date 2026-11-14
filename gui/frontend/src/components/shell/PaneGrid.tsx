import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { zoomFactor } from "@/lib/zoom";
import { afterRev, runLayoutCommand } from "@/shell/commands";
import { leaveFullscreen, useFullscreenPane } from "@/shell/fullscreen";
import { shellFrame } from "@/shell/geometry/rails";
import { panesOf, type Frame, type GeoNode } from "@/shell/geometry/types";
import { dragSizes, evenSizes, sizesArg, startDrag, withSizes, type GutterDrag } from "@/shell/resize";
import { reportViewport } from "@/shell/viewport";
import { geoTree, useCurrentSpaceId, useLayoutStore, useTree, type LayoutState } from "@/stores/layout";
import { setShellFrame, useShellViewStore } from "@/stores/shellView";
import { EmptySpace } from "./EmptySpace";
import { Gutter } from "./Gutter";
import { PaneView } from "./PaneView";

/**
 * What the drawn frame depends on beyond the tree's shape, in one string: each pane's tabs (kind
 * and thread: the minimums go by the active tab's kind, the fold order by whether a pane holds a
 * thread's tab and which thread the focused tab belongs to), its active tab, and whether the user
 * collapsed it. The grid lays out
 * again only when it changes, not when a tab is renamed.
 */
function tabsKey(s: LayoutState, spaceId: string): string {
  return Object.values(s.panes)
    .filter((p) => p.spaceId === spaceId)
    .map((p) => `${p.id}${p.collapsed ? "!" : ""}=${p.active}|${p.tabIds.map((id) => `${id}:${s.tabs[id]?.kind ?? ""}:${s.tabs[id]?.thread ?? ""}`).join(",")}`)
    .sort()
    .join("\n");
}

/** The frame of full screen: the one pane over the whole area, no gutter. */
function fullscreenFrame(pane: string, w: number, h: number): Frame {
  return { w, h, rects: { [pane]: { x: 0, y: 0, w, h, rail: false } }, gutters: [] };
}

/**
 * The current space's panes, tiling the content area (docs/notes/shell-model.md, "Structure"):
 * the layout's tree laid out with pane minimums (shell/geometry), each pane absolutely placed at
 * its rectangle, 12px gutters between them that resize by drag. The area's size goes to the
 * daemon (SetViewport) for placement. A space with no pane shows the composer (EmptySpace).
 * When the area cannot keep every pane at its minimum, panes fold to rails (shell/geometry/rails:
 * derived per frame, the stored layout unchanged). In full screen only the focused pane is drawn,
 * over the whole area; the others mount nothing. See docs/notes/shell-19-rails-fullscreen.md.
 */
export function PaneGrid() {
  const spaceId = useCurrentSpaceId();
  const tree = useTree(spaceId);
  const tabs = useLayoutStore((s) => tabsKey(s, spaceId));
  const focus = useLayoutStore((s) => s.spaces[spaceId]?.focus ?? "");
  const mru = useLayoutStore((s) => s.spaces[spaceId]?.mru);
  const full = useFullscreenPane();
  const fullscreenSpace = useShellViewStore((s) => s.fullscreen);
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

  // The tree with its tabs (minimums and fold order), and the gutter being dragged's sizes on top.
  const stored = useMemo<GeoNode | null>(
    () => (tree ? geoTree(useLayoutStore.getState(), spaceId) : null),
    // `tabs` stands for what the tree reads from the panes and tabs.
    // oxlint-disable-next-line react/exhaustive-deps
    [tree, tabs, spaceId],
  );
  const shown = useMemo(() => (drag ? withSizes(stored, drag.d.split, drag.sizes) : stored), [stored, drag]);
  const frame = useMemo<Frame | null>(() => {
    if (!size || !shown) return null;
    if (full) return fullscreenFrame(full, size.w, size.h);
    return shellFrame({ root: shown, w: size.w, h: size.h, focus, mru });
  }, [shown, size, full, focus, mru]);
  // Full screen ends when its space is left or has no pane to show.
  useEffect(() => {
    if (fullscreenSpace && !full) leaveFullscreen();
  }, [fullscreenSpace, full]);
  useEffect(() => {
    setShellFrame(frame);
  }, [frame]);
  useEffect(
    () => () => {
      setShellFrame(null);
    },
    [],
  );

  /** pane.resize with these sizes; their preview stays until the daemon's commit arrives (or a newer one replaces it), so the panes do not jump back. */
  const commit = (next: { d: GutterDrag; sizes: number[] }) => {
    setDrag(next);
    void runLayoutCommand("pane.resize", { split: next.d.split, sizes: sizesArg(next.sizes) })
      .then((res) => (res ? afterRev(res.rev) : undefined))
      .finally(() => {
        setDrag((cur) => (cur === next ? null : cur));
      });
  };

  const panes = useMemo(() => (full ? [full] : panesOf(shown).map((p) => p.id)), [shown, full]);
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
              commit(cur);
            }}
            onStep={(delta) => {
              // From what is drawn (a step whose commit is on its way included), so quick presses add up.
              const d = startDrag(shown, frame, g.split, g.i);
              if (d) commit({ d, sizes: dragSizes(d, delta) });
            }}
            onReset={() => {
              const d = startDrag(shown, frame, g.split, g.i);
              if (d) commit({ d, sizes: evenSizes(d) });
            }}
          />
        ))}
    </div>
  );
}
