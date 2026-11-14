import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DndContext, PointerSensor, useSensor, useSensors, type Announcements, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { PANE_HEADER_HEIGHT } from "@/components/window/titleBand";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { afterRev, runLayoutCommand } from "@/shell/commands";
import { cancelledText, DRAG_INSTRUCTIONS, droppedText, overText, pickedUpText, sourceText, type DragNames } from "@/shell/drag/announce";
import { sourceOf } from "@/shell/drag/draggable";
import { dropCommand, dropPreview, shellDropLayout, type DropLayout } from "@/shell/drag/drop";
import { fullscreenOn } from "@/shell/fullscreen";
import { resetShellDrag, useShellDragStore } from "@/shell/drag/state";
import { dropTarget, insertionBar, sameTarget, type DragScene, type DragSource, type DropTarget, type StripTab } from "@/shell/drag/targets";
import { threadDropArgs } from "@/shell/drag/threadDrop";
import { panesOf, type GeoNode } from "@/shell/geometry/types";
import { paneFitsInSpace } from "@/shell/drag/room";
import { runSpaceDrop } from "@/shell/spaceActions";
import { spaceDropCommands } from "@/shell/spaces";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { geoTree, spaceOfThread, useCurrentSpaceId, useLayoutStore, type TabEntry } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useShellViewStore } from "@/stores/shellView";

/** A box in viewport px. */
interface ClientBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The top bar and its space tabs as drawn (viewport px): the tabs are drop targets, the rest of the bar is none. */
interface TopBarBoxes {
  bar: ClientBox | null;
  spaces: { id: string; box: ClientBox }[];
}

function measureTopBar(): TopBarBoxes {
  const bar = document.querySelector<HTMLElement>('[data-testid="top-bar"]');
  if (!bar) return { bar: null, spaces: [] };
  const spaces = Array.from(bar.querySelectorAll<HTMLElement>('[data-testid="space-tab"]')).map((el) => ({ id: el.dataset.spaceId ?? "", box: el.getBoundingClientRect() }));
  return { bar: bar.getBoundingClientRect(), spaces };
}

const within = (b: ClientBox, p: { x: number; y: number }) => p.x >= b.left && p.x < b.right && p.y >= b.top && p.y < b.bottom;

/** What a drag reads at its start (and again when the grid redraws under it). */
interface Snapshot {
  /** The grid's top left in the viewport, in layout px (where the preview's coordinates start). */
  origin: { x: number; y: number };
  scene: DragScene;
  tree: GeoNode | null;
  /** How the grid lays out a tree: with its rails, the dropped pane holding the focus. */
  lay: DropLayout;
  names: DragNames;
}

/** The strips as drawn: each pane's tabs with their extents in the grid's layout px, and their names. */
function measureStrips(grid: HTMLElement): Record<string, StripTab[]> {
  const g = grid.getBoundingClientRect();
  const z = zoomFactor();
  const out: Record<string, StripTab[]> = {};
  // A rail's tabs too: their names and count (a rail is one target as a whole, so their places are not used).
  for (const pane of Array.from(grid.querySelectorAll<HTMLElement>('[data-testid="shell-pane"], [data-testid="shell-rail"]'))) {
    const id = pane.dataset.paneId ?? "";
    out[id] = Array.from(pane.querySelectorAll<HTMLElement>('[data-testid="shell-tab"], [data-testid="shell-rail-tab"]')).map((t) => {
      const r = t.getBoundingClientRect();
      return {
        id: t.dataset.tabId ?? "",
        x: (r.left - g.left) / z,
        w: r.width / z,
        title: t.querySelector('[data-testid="shell-tab-label"]')?.textContent ?? "",
      };
    });
  }
  return out;
}

function snapshot(grid: HTMLElement | null, spaceId: string): Snapshot | null {
  const frame = useShellViewStore.getState().frame;
  if (!grid || !frame) return null;
  const strips = measureStrips(grid);
  const layout = useLayoutStore.getState();
  const titles = new Map(Object.values(strips).flatMap((tabs) => tabs.map((t) => [t.id, t.title] as const)));
  const names: DragNames = {
    tab: (id) => titles.get(id) || "untitled",
    pane: (id) => titles.get(layout.panes[id]?.active ?? "") || "untitled",
    tabCount: (id) => strips[id]?.length ?? 0,
    thread: (id) => useThreadsStore.getState().byId[id]?.name || "untitled",
  };
  const g = grid.getBoundingClientRect();
  const z = zoomFactor();
  const tree = geoTree(layout, spaceId);
  return {
    origin: { x: g.left / z, y: g.top / z },
    // The tree: a drop whose result would not fit the grid is not offered (shell/drag/room.ts).
    scene: { frame, strips, stripHeight: PANE_HEADER_HEIGHT, tree },
    tree,
    lay: shellDropLayout(layout.spaces[spaceId]?.mru),
    names,
  };
}

/**
 * Whether a pane dropped on a space tab fits that space (pane.move --space puts it right of the
 * space's focused pane; docs/notes/shell-model.md, "Room for panes"). A tab or a thread goes into
 * a pane there, so only a pane is checked.
 */
function fitsInSpace(source: DragSource, space: string, s: Snapshot): boolean {
  if (source.kind !== "pane") return true;
  const pane = panesOf(s.tree).find((p) => p.id === source.pane);
  if (!pane) return true;
  const layout = useLayoutStore.getState();
  return paneFitsInSpace(geoTree(layout, space), layout.spaces[space]?.focus, pane, s.scene.frame);
}

/** A space's name for the announcements. */
function spaceName(id: string): string {
  return useLayoutStore.getState().spaces[id]?.name ?? id;
}

/** The label on a preview: what the drop makes. */
function previewLabel(source: DragSource, target: DropTarget): string {
  switch (target.kind) {
    case "outer":
      return target.edge === "left" || target.edge === "right" ? "Full-height column" : "Full-width row";
    case "edge":
      return source.kind === "pane" ? "Move pane here" : "New pane";
    case "pane":
      return source.kind === "pane" ? "Merge tabs" : source.kind === "thread" ? "Open here" : "Add to this pane";
    case "strip":
      return "";
  }
}

/** What the drag layer draws over the grid: the drop's rectangle with its label, or a strip's insertion bar. */
function DropPreview() {
  const origin = useShellDragStore((s) => s.origin);
  const preview = useShellDragStore((s) => s.preview);
  const bar = useShellDragStore((s) => s.bar);
  const target = useShellDragStore((s) => s.target);
  const source = useShellDragStore((s) => s.source);
  const outer = target?.kind === "outer";
  return (
    <>
      {preview && target && source && (
        <div
          aria-hidden
          data-testid="shell-drop-preview"
          data-kind={target.kind}
          className={cn(
            "pointer-events-none fixed z-[55] flex items-center justify-center rounded-pane border-2 transition-[left,top,width,height] duration-75",
            outer ? "border-dashed border-cf-accent bg-cf-accent/15" : "border-cf-focus bg-cf-focus/15",
          )}
          style={{ left: origin.x + preview.x, top: origin.y + preview.y, width: preview.w, height: preview.h }}
        >
          <span className={cn("rounded-md bg-cf-surface-overlay px-2 py-0.5 text-caption font-medium shadow-sm ring-1", outer ? "text-cf-accent ring-cf-accent" : "text-cf-focus ring-cf-focus")}>
            {previewLabel(source, target)}
          </span>
        </div>
      )}
      {bar && (
        <div
          aria-hidden
          data-testid="shell-drop-bar"
          className="pointer-events-none fixed z-[55] w-0.5 rounded-full bg-cf-focus"
          style={{ left: origin.x + bar.x, top: origin.y + bar.y, height: bar.h }}
        />
      )}
    </>
  );
}

/** The lifted tab (or pane, named by its active tab), under the pointer. Not a tab to assistive tech. */
function DragGhost() {
  const source = useShellDragStore((s) => s.source);
  const client = useShellDragStore((s) => s.client);
  const tab = useLayoutStore((s) => {
    if (!source) return undefined;
    // A sidebar thread has no tab yet: the ghost draws the one it will open.
    if (source.kind === "thread") return threadGhostTab(source.thread);
    return s.tabs[source.kind === "tab" ? source.tab : (s.panes[source.pane]?.active ?? "")];
  });
  const more = useLayoutStore((s) => (source?.kind === "pane" ? (s.panes[source.pane]?.tabIds.length ?? 1) - 1 : 0));
  if (!source || !client || !tab) return null;
  const surface = shellSurfaceOf(tab.kind);
  const Icon = surface.icon;
  const z = zoomFactor();
  return (
    <div
      aria-hidden
      data-testid="shell-drag-ghost"
      data-kind={source.kind}
      className="pointer-events-none fixed z-[60] flex h-7 max-w-64 items-center gap-1.5 rounded-md bg-cf-surface-overlay pr-3 pl-2 text-body-sm text-cf-text shadow-md ring-1 ring-cf-border"
      style={{ left: client.x / z + 12, top: client.y / z + 10 }}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <GhostTitle tab={tab} />
      {more > 0 && <span className="shrink-0 text-cf-text-muted">+{more}</span>}
    </div>
  );
}

const ghostTabs = new Map<string, TabEntry>();

/** The tab a sidebar thread's drop opens, as the ghost draws it (one object per thread, for the selector). */
function threadGhostTab(thread: string): TabEntry {
  let t = ghostTabs.get(thread);
  if (!t) {
    t = { id: "", kind: "thread", thread, key: "", params: {}, title: "", name: "", paneId: "" };
    ghostTabs.set(thread, t);
  }
  return t;
}

function GhostTitle({ tab }: { tab: TabEntry }) {
  const title = shellSurfaceOf(tab.kind).useTitle(tab);
  return <span className="truncate">{title}</span>;
}

/**
 * A sidebar thread whose tab is open in the space drags as that tab (a move, never a second
 * tab). One of another space (a Needs you row) stays a thread: it can only go to a space tab.
 */
function openThreadAsTab(src: DragSource | null, spaceId: string): DragSource | null {
  if (src?.kind !== "thread") return src;
  const s = useLayoutStore.getState();
  if (spaceOfThread(s, src.thread) !== spaceId) return src;
  const tab = Object.values(s.tabs).find((t) => t.kind === "thread" && t.thread === src.thread && s.panes[t.paneId]?.spaceId === spaceId);
  return tab ? { kind: "tab", tab: tab.id, pane: tab.paneId } : src;
}

/** Opens a sidebar thread where it was dropped (shell/drag/threadDrop.ts): one thread.open with the place. */
async function dropThread(thread: string, target: DropTarget): Promise<void> {
  const opened = await runLayoutCommand("thread.open", threadDropArgs(thread, target));
  if (opened) await afterRev(opened.rev);
}

/**
 * The pane grid's drag layer (docs/notes/shell-model.md, "Structure"): any tab drags (active or
 * not) to a place in a strip, onto a pane, onto a pane's edge, or onto the grid's outer edge; a
 * whole pane drags by its strip's free space to the same places. Hit-testing is
 * shell/drag/targets.ts on the drawn frame; the drop is one `tab.move` or `pane.move`
 * (shell/drag/drop.ts); a thread row from the sidebar opens where it lands (shell/drag/threadDrop.ts),
 * so the context wraps the sidebar too (ShellDndRoot). While a drag is on, a transparent shield over the window takes the
 * pointer, so a terminal or an iframe under it never swallows the moves. Escape cancels
 * (dnd-kit's pointer sensor). It wraps the sidebar and the shell (App.tsx) and finds the grid inside itself.
 * See docs/notes/shell-14-drag.md.
 */
export function ShellDnd({ children }: { children: ReactNode }) {
  const spaceId = useCurrentSpaceId();
  const wrap = useRef<HTMLDivElement>(null);
  const gridEl = () => wrap.current?.querySelector<HTMLElement>('[data-testid="shell-grid"]') ?? null;
  // A drag starts after 4px of travel, so a click, the × and a middle click stay what they are.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const snap = useRef<Snapshot | null>(null);
  const origin = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // The last drop, for the announcement dnd-kit makes after onDragEnd has cleared the state.
  const ended = useRef<{
    source: DragSource;
    target: DropTarget | null;
  } | null>(null);
  const announced = useRef<DropTarget | null>(null);
  const announcedSpace = useRef("");
  const topBar = useRef<TopBarBoxes>({ bar: null, spaces: [] });
  // The drop on a space tab, for the announcement after onDragEnd cleared the state.
  const endedSpace = useRef("");
  const source = useShellDragStore((s) => s.source);

  // The grid redrawn under a drag (a tab opened elsewhere, the window resized): measure again.
  useEffect(() => {
    if (!source) return;
    return useShellViewStore.subscribe((s, prev) => {
      if (s.frame !== prev.frame) snap.current = snapshot(gridEl(), spaceId);
    });
    // oxlint-disable-next-line react/exhaustive-deps
  }, [source, spaceId]);
  useEffect(
    () => () => {
      resetShellDrag();
    },
    [],
  );

  const retarget = (client: { x: number; y: number }) => {
    const st = useShellDragStore.getState();
    const s = snap.current;
    if (!st.source || !s) return;
    // The top bar: a space tab that would take the source is the target; the rest of the bar is
    // none (the grid's outer band above the panes stops at the bar).
    const tb = topBar.current;
    if (tb.bar && within(tb.bar, client)) {
      const hit = tb.spaces.find((x) => within(x.box, client));
      const space = hit && spaceDropCommands(st.source, hit.id, useLayoutStore.getState()) && fitsInSpace(st.source, hit.id, s) ? hit.id : "";
      useShellDragStore.setState({ client, target: null, preview: null, bar: null, space });
      return;
    }
    if (st.space) useShellDragStore.setState({ space: "" });
    // A thread of another space has no place in this grid: only a space tab takes it.
    if (st.source.kind === "thread" && spaceOfThread(useLayoutStore.getState(), st.source.thread) !== spaceId) {
      useShellDragStore.setState({ client, target: null, preview: null, bar: null });
      return;
    }
    const z = zoomFactor();
    const found = dropTarget(s.scene, st.source, { x: client.x / z - s.origin.x, y: client.y / z - s.origin.y });
    // In full screen a tab only moves within its strip (or to a space): a new pane would be out of sight.
    const target = found && fullscreenOn() && found.kind !== "strip" ? null : found;
    if (sameTarget(target, st.target)) {
      useShellDragStore.setState({ client });
      return;
    }
    useShellDragStore.setState({
      client,
      target,
      preview: target ? dropPreview(s.tree, s.scene.frame, st.source, target, s.lay) : null,
      bar: target?.kind === "strip" ? insertionBar(s.scene, target.pane, target.index) : null,
    });
  };

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const src = openThreadAsTab(sourceOf(active.data.current), spaceId);
    snap.current = snapshot(gridEl(), spaceId);
    if (!src || !snap.current) return;
    const p = activatorEvent as PointerEvent;
    origin.current = { x: p.clientX, y: p.clientY };
    ended.current = null;
    announced.current = null;
    announcedSpace.current = "";
    endedSpace.current = "";
    topBar.current = measureTopBar();
    useShellDragStore.setState({ source: src, target: null, client: origin.current, origin: snap.current.origin, preview: null, bar: null });
  };
  // The pointer as the window sees it. dnd-kit's move delta adds the scroll of the source's scroll
  // containers, so a sidebar row whose list scrolls under the drag (a row re-measured) would aim
  // somewhere the pointer is not.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!source) return;
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", onMove, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      pointer.current = null;
    };
  }, [source]);
  const onDragMove = ({ delta }: DragMoveEvent) => {
    retarget(pointer.current ?? { x: origin.current.x + delta.x, y: origin.current.y + delta.y });
  };
  const onDragEnd = () => {
    const { source: src, target, space } = useShellDragStore.getState();
    resetShellDrag();
    if (!src) return;
    ended.current = { source: src, target };
    if (space) {
      const cmds = spaceDropCommands(src, space, useLayoutStore.getState());
      endedSpace.current = cmds ? space : "";
      if (cmds) void runSpaceDrop(cmds);
      return;
    }
    if (!target) return;
    if (src.kind === "thread") {
      void dropThread(src.thread, target);
      return;
    }
    const layout = useLayoutStore.getState();
    // The layout as it is now: a dragged tab or pane closed mid-drag moves nothing.
    if (src.kind === "tab" ? !layout.tabs[src.tab] : !layout.panes[src.pane]) return;
    const cmd = dropCommand(src, target, layout.panes[src.pane]?.tabIds ?? []);
    if (!cmd) return;
    void runLayoutCommand(cmd.name, cmd.args).then((res) => (res ? afterRev(res.rev) : undefined));
  };
  const onDragCancel = () => {
    const { source: src } = useShellDragStore.getState();
    resetShellDrag();
    if (src) ended.current = { source: src, target: null };
  };

  const announcements = useMemo<Announcements>(() => {
    const names = (): DragNames =>
      snap.current?.names ?? {
        tab: () => "untitled",
        pane: () => "untitled",
        tabCount: () => 0,
        thread: () => "untitled",
      };
    return {
      onDragStart: () => {
        const src = useShellDragStore.getState().source;
        return src ? pickedUpText(src, names()) : undefined;
      },
      onDragMove: () => {
        const { source: src, target, space } = useShellDragStore.getState();
        if (!src || (sameTarget(target, announced.current) && space === announcedSpace.current)) return undefined;
        announced.current = target;
        announcedSpace.current = space;
        if (space) return `${sourceText(src, names())} is over the space ${spaceName(space)}.`;
        return overText(src, target, names());
      },
      onDragOver: () => undefined,
      onDragEnd: () => {
        if (!ended.current) return undefined;
        if (endedSpace.current) return `${sourceText(ended.current.source, names())} was moved to the space ${spaceName(endedSpace.current)}.`;
        return droppedText(ended.current.source, ended.current.target, names());
      },
      onDragCancel: () => (ended.current ? cancelledText(ended.current.source, names()) : undefined),
    };
  }, []);

  return (
    <DndContext
      sensors={sensors}
      autoScroll={false}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: DRAG_INSTRUCTIONS },
      }}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div ref={wrap} className="contents">
        {children}
      </div>
      {/* In document.body: the shield takes the pointer from everything under it (a terminal, an
          iframe) for the whole drag, and nothing drawn for the drag is clipped by a pane. */}
      {source &&
        createPortal(
          <>
            <div aria-hidden data-testid="shell-drag-shield" className="fixed inset-0 z-50 cursor-grabbing" />
            <DropPreview />
            <DragGhost />
          </>,
          document.body,
        )}
    </DndContext>
  );
}
