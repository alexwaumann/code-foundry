import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DndContext, PointerSensor, useSensor, useSensors, type Announcements, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { PANE_HEADER_HEIGHT } from "@/components/window/titleBand";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { cancelledText, DRAG_INSTRUCTIONS, droppedText, groupText, headerDroppedText, headerOverText, overText, pickedUpText, sourceText, targetText, type DragNames } from "@/shell/drag/announce";
import { sourceOf } from "@/shell/drag/draggable";
import { dropPreview, shellDropLayout, type DropLayout } from "@/shell/drag/drop";
import { dropPlan, groupDropPlan } from "@/shell/drag/dropPlan";
import { groupDropsInGrid, groupSpaceCommands, headerDropIds, rowDragGroup, type HeaderSection } from "@/shell/drag/groupDrop";
import { fullscreenOn } from "@/shell/fullscreen";
import { resetShellDrag, useShellDragStore } from "@/shell/drag/state";
import { dropTarget, insertionBar, sameTarget, type DragScene, type DragSource, type DropTarget, type SceneModes, type StripTab } from "@/shell/drag/targets";
import { modeDrop, modeDropDone, modeDropLabel, modeDropOver, type ModeDrop } from "@/shell/drag/modeDrop";
import { THREADS_OPEN_AS_KEY, targetThreadPane, threadLikeKind, threadsOpenAsOf } from "@/shell/threadsOpenAs";
import { useSettingsStore } from "@/stores/settings";
import { rowDragSource, threadDropsInGrid } from "@/shell/drag/threadSource";
import { panesOf, type GeoNode } from "@/shell/geometry/types";
import { paneFitsInSpace } from "@/shell/drag/room";
import { runGridDrop, runSpaceDrop } from "@/shell/spaceActions";
import { spaceDropCommands } from "@/shell/spaces";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { geoTree, useCurrentSpaceId, useLayoutStore, type TabEntry } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useShellViewStore } from "@/stores/shellView";
import { archiveThreads, saveThreadsForLater } from "@/stores/bulkThreadActions";
import { clearSidebarSelection, selectedSidebarThreads, useSidebarSelectionStore } from "@/stores/sidebarSelection";

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

/** The sidebar's Archived and Snoozed headers as drawn (viewport px): drop targets for a row's drag (docs/notes/sidebar-bulk-select.md). */
function measureHeaders(): { section: HeaderSection; box: ClientBox }[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-drop-section]")).flatMap((el) => {
    const section = el.dataset.dropSection;
    return section === "archived" || section === "snoozed" ? [{ section, box: el.getBoundingClientRect() }] : [];
  });
}

/** Whether the thread is archived (it lives in no space: shell/drag/threadSource.ts). */
const isArchived = (id: string) => (useThreadsStore.getState().byId[id]?.archivedAtMs ?? null) !== null;

/** The threads a row's drag carries: the dragged selection, else the row's own thread. */
function draggedThreads(st: { rowThread: string; group: readonly string[] }): readonly string[] {
  return st.group.length > 0 ? st.group : st.rowThread ? [st.rowThread] : [];
}

/** What a drag reads at its start (and again when the grid redraws under it). */
interface Snapshot {
  /** The grid's top left in the viewport, in layout px (where the preview's coordinates start). */
  origin: { x: number; y: number };
  scene: DragScene;
  tree: GeoNode | null;
  /** How the grid lays out a tree: with its rails, the dropped pane holding the focus. */
  lay: DropLayout;
  names: DragNames;
  /** No pane grid to drop in (a space with no pane): only a space tab or a sidebar header takes the drag. */
  noGrid?: boolean;
}

/** The strips as drawn: each pane's tabs with their extents in the grid's layout px, and their names. */
function measureStrips(grid: HTMLElement): Record<string, StripTab[]> {
  const g = grid.getBoundingClientRect();
  const z = zoomFactor();
  const out: Record<string, StripTab[]> = {};
  // A rail's tabs too: their names and count (a rail is one target as a whole, so their places are not used).
  for (const pane of Array.from(grid.querySelectorAll<HTMLElement>('[data-testid="shell-pane"], [data-testid="shell-rail"]'))) {
    const id = pane.dataset.paneId ?? "";
    // A thread pane's header row (Threads open as Panes or Single) is its one tab: its title.
    out[id] = Array.from(pane.querySelectorAll<HTMLElement>('[data-testid="shell-tab"], [data-testid="shell-rail-tab"], [data-testid="thread-pane-header-title"]')).map((t) => {
      const r = t.getBoundingClientRect();
      return {
        id: t.dataset.tabId ?? "",
        x: (r.left - g.left) / z,
        w: r.width / z,
        title: t.querySelector('[data-testid="shell-tab-label"], [data-testid="thread-pane-header-name"]')?.textContent ?? "",
      };
    });
  }
  return out;
}

/** The snapshot of a space with no pane grid: a sidebar row still drags to a space tab or a header. */
function gridless(spaceId: string): Snapshot {
  const layout = useLayoutStore.getState();
  return {
    origin: { x: 0, y: 0 },
    scene: { frame: { w: 0, h: 0, rects: {}, gutters: [] }, strips: {}, stripHeight: PANE_HEADER_HEIGHT, tree: null },
    tree: null,
    lay: shellDropLayout(layout.spaces[spaceId]?.mru),
    names: { tab: () => "untitled", pane: () => "untitled", tabCount: () => 0, thread: (id) => useThreadsStore.getState().byId[id]?.name || "untitled" },
    noGrid: true,
  };
}

/**
 * The space as the drop rules of Threads open as Panes and Single read it (shell/drag/targets.ts
 * SceneModes); undefined under Tabs. A thread pane is named by its thread, as its row shows it.
 */
function sceneModes(spaceId: string, title: (tab: string) => string): SceneModes | undefined {
  const mode = threadsOpenAsOf(useSettingsStore.getState().snapshot?.values[THREADS_OPEN_AS_KEY]);
  if (mode === "tabs") return undefined;
  const layout = useLayoutStore.getState();
  const threadPanes: Record<string, string> = {};
  const threadTabs = new Set<string>();
  for (const p of Object.values(layout.panes)) {
    if (p.spaceId !== spaceId) continue;
    for (const id of p.tabIds) {
      if (!threadLikeKind(layout.tabs[id]?.kind)) continue;
      threadTabs.add(id);
      threadPanes[p.id] ??= title(id);
    }
  }
  return { mode, threadPanes, threadTabs, target: targetThreadPane(layout, spaceId) };
}

function snapshot(grid: HTMLElement | null, spaceId: string, row = false): Snapshot | null {
  const frame = useShellViewStore.getState().frame;
  if (!grid || !frame) return row ? gridless(spaceId) : null;
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
  const modes = sceneModes(spaceId, (id) => titles.get(id) || "untitled");
  return {
    origin: { x: g.left / z, y: g.top / z },
    // The tree: a drop whose result would not fit the grid is not offered (shell/drag/room.ts).
    scene: { frame, strips, stripHeight: PANE_HEADER_HEIGHT, tree, ...(modes && { modes }) },
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

/** The label on a preview: what the drop makes; under Threads open as Panes or Single, for a thread, what it does to the thread shown (`effect`). */
function previewLabel(source: DragSource, target: DropTarget, effect: ModeDrop | null | undefined): string {
  if (effect) return modeDropLabel(effect);
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
  const effect = useShellDragStore((s) => s.effect);
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
            {previewLabel(source, target, effect)}
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
  // The dragged selection: the grabbed row with how many go.
  const count = useShellDragStore((s) => s.group.length);
  if (!source || !client || !tab) return null;
  const surface = shellSurfaceOf(tab.kind);
  const Icon = surface.icon;
  const z = zoomFactor();
  return (
    <div
      aria-hidden
      data-testid="shell-drag-ghost"
      data-kind={source.kind}
      data-count={count > 1 ? count : undefined}
      className="pointer-events-none fixed z-[60] flex h-7 max-w-64 items-center gap-1.5 rounded-md bg-cf-surface-overlay pr-3 pl-2 text-body-sm text-cf-text shadow-md ring-1 ring-cf-border"
      style={{ left: client.x / z + 12, top: client.y / z + 10 }}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <GhostTitle tab={tab} />
      {more > 0 && <span className="shrink-0 text-cf-text-muted">+{more}</span>}
      {count > 1 && (
        <span className="ml-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-cf-accent px-1 text-caption-sm font-medium text-cf-accent-foreground tabular-nums" data-testid="shell-drag-count">
          {count}
        </span>
      )}
    </div>
  );
}

const ghostTabs = new Map<string, TabEntry>();

/** The tab a sidebar thread's drop opens, as the ghost draws it (one object per thread, for the selector). */
function threadGhostTab(thread: string): TabEntry {
  let t = ghostTabs.get(thread);
  if (!t) {
    t = { id: "", kind: "thread", thread, key: "", params: {}, title: "", name: "", preview: false, paneId: "" };
    ghostTabs.set(thread, t);
  }
  return t;
}

function GhostTitle({ tab }: { tab: TabEntry }) {
  const title = shellSurfaceOf(tab.kind).useTitle(tab);
  return <span className="truncate">{title}</span>;
}

/**
 * The pane grid's drag layer (docs/notes/shell-model.md, "Structure"): any tab drags (active or
 * not) to a place in a strip, onto a pane, onto a pane's edge, or onto the grid's outer edge; a
 * whole pane drags by its strip's free space to the same places. Hit-testing is
 * shell/drag/targets.ts on the drawn frame; the drop is one `tab.move` or `pane.move`
 * (shell/drag/drop.ts); a thread row from the sidebar, of any section, opens where it lands
 * (shell/drag/threadDrop.ts, shell/drag/threadSource.ts), so the context wraps the sidebar too
 * (ShellDndRoot); shell/drag/dropPlan.ts says what a drop runs. While a drag is on, a transparent shield over the window takes the
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
    group: readonly string[];
    section: HeaderSection | "";
  } | null>(null);
  const announced = useRef<DropTarget | null>(null);
  const announcedSpace = useRef("");
  const announcedSection = useRef("");
  const topBar = useRef<TopBarBoxes>({ bar: null, spaces: [] });
  // The drop on a space tab, for the announcement after onDragEnd cleared the state.
  const endedSpace = useRef("");
  const source = useShellDragStore((s) => s.source);

  // The grid redrawn under a drag (a tab opened elsewhere, the window resized): measure again.
  useEffect(() => {
    if (!source) return;
    return useShellViewStore.subscribe((s, prev) => {
      if (s.frame !== prev.frame) snap.current = snapshot(gridEl(), spaceId, useShellDragStore.getState().rowThread !== "");
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
    // The sidebar's Archived and Snoozed headers take a row's drag when the drop would act on one of its threads.
    if (st.rowThread) {
      const hit = measureHeaders().find((h) => within(h.box, client));
      if (hit) {
        const acts = headerDropIds(hit.section, draggedThreads(st), useThreadsStore.getState().byId).length > 0;
        useShellDragStore.setState({ client, target: null, preview: null, bar: null, space: "", section: acts ? hit.section : "" });
        return;
      }
      if (st.section) useShellDragStore.setState({ section: "" });
    }
    // The top bar: a space tab that would take the source is the target; the rest of the bar is
    // none (the grid's outer band above the panes stops at the bar).
    const tb = topBar.current;
    if (tb.bar && within(tb.bar, client)) {
      const hit = tb.spaces.find((x) => within(x.box, client));
      const layout = useLayoutStore.getState();
      const takes = (id: string) => (st.group.length > 0 ? groupSpaceCommands(st.group, id, layout, isArchived) : spaceDropCommands(st.source as DragSource, id, layout));
      const space = hit && takes(hit.id) && fitsInSpace(st.source, hit.id, s) ? hit.id : "";
      useShellDragStore.setState({ client, target: null, preview: null, bar: null, space });
      return;
    }
    if (st.space) useShellDragStore.setState({ space: "" });
    if (s.noGrid) {
      useShellDragStore.setState({ client, target: null, preview: null, bar: null });
      return;
    }
    // A thread of another space has no place in this grid: only a space tab takes it (an archived
    // one with no tab open lives in none, so it does: shell/drag/threadSource.ts).
    // A dragged selection drops in the grid only when every one of its threads would.
    const offGrid = st.group.length > 0 ? !groupDropsInGrid(st.group, useLayoutStore.getState(), spaceId, isArchived) : st.source.kind === "thread" && !threadDropsInGrid(st.source, useLayoutStore.getState(), spaceId);
    if (offGrid) {
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
      effect: target ? modeDrop(s.scene, st.source, target) : null,
      preview: target ? dropPreview(s.tree, s.scene.frame, st.source, target, s.lay) : null,
      bar: target?.kind === "strip" ? insertionBar(s.scene, target.pane, target.index) : null,
    });
  };

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const raw = sourceOf(active.data.current);
    // A selected row while two or more are selected drags the whole selection; any other row
    // drags alone and drops the selection (docs/notes/sidebar-bulk-select.md).
    let group: readonly string[] = [];
    if (raw?.kind === "thread") {
      const lift = rowDragGroup(raw.thread, useSidebarSelectionStore.getState().ids, selectedSidebarThreads());
      group = lift.group;
      if (!lift.keep) clearSidebarSelection();
    }
    // A sidebar thread whose tab is open in the space drags as that tab (a move, never a second tab).
    const src = rowDragSource(raw, useLayoutStore.getState(), spaceId);
    snap.current = snapshot(gridEl(), spaceId, raw?.kind === "thread");
    if (!src || !snap.current) return;
    const p = activatorEvent as PointerEvent;
    origin.current = { x: p.clientX, y: p.clientY };
    ended.current = null;
    announced.current = null;
    announcedSpace.current = "";
    announcedSection.current = "";
    endedSpace.current = "";
    topBar.current = measureTopBar();
    useShellDragStore.setState({
      source: src,
      target: null,
      client: origin.current,
      origin: snap.current.origin,
      preview: null,
      bar: null,
      rowThread: raw?.kind === "thread" ? raw.thread : "",
      group,
      section: "",
    });
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
    const st = useShellDragStore.getState();
    const { source: src, target, space, group, section } = st;
    resetShellDrag();
    if (!src) return;
    ended.current = { source: src, target, group, section };
    // On the Archived or Snoozed header: one thread.archive or thread.snooze --save with the threads it acts on.
    if (section) {
      endedSpace.current = "";
      const ids = headerDropIds(section, draggedThreads(st), useThreadsStore.getState().byId);
      if (ids.length > 0) void (section === "archived" ? archiveThreads(ids, true) : saveThreadsForLater(ids));
      return;
    }
    if (group.length > 0) {
      const plan = groupDropPlan(group, target, space, useLayoutStore.getState(), spaceId, isArchived);
      endedSpace.current = plan?.space ?? "";
      if (plan) {
        void (plan.space ? runSpaceDrop(plan.commands) : runGridDrop(plan.commands)).then((ok) => {
          if (ok) clearSidebarSelection();
        });
      }
      return;
    }
    // The layout as it is now: a dragged tab or pane closed mid-drag moves nothing.
    const plan = dropPlan(src, target, space, useLayoutStore.getState());
    endedSpace.current = plan?.space ?? "";
    // A drop on a space tab leaves the keyboard here; one in the grid hands it to the pane it focused.
    if (plan) void (plan.space ? runSpaceDrop(plan.commands) : runGridDrop(plan.commands));
  };
  const onDragCancel = () => {
    const { source: src, group } = useShellDragStore.getState();
    resetShellDrag();
    if (src) ended.current = { source: src, target: null, group, section: "" };
  };

  const announcements = useMemo<Announcements>(() => {
    const names = (): DragNames =>
      snap.current?.names ?? {
        tab: () => "untitled",
        pane: () => "untitled",
        tabCount: () => 0,
        thread: () => "untitled",
      };
    // A dragged selection is named by its count ("3 threads (Fix login and 2 more)").
    const what = (src: DragSource, group: readonly string[]) => (group.length > 1 ? groupText(group, names()) : sourceText(src, names()));
    return {
      onDragStart: () => {
        const { source: src, group } = useShellDragStore.getState();
        if (!src) return undefined;
        if (group.length > 1) return `Picked up ${what(src, group)}. Move them over a pane, a strip, an edge, a space tab or the Archived or Snoozed header and release to drop them there, or press Escape to cancel.`;
        return pickedUpText(src, names());
      },
      onDragMove: () => {
        const st = useShellDragStore.getState();
        const { source: src, target, space, group, section } = st;
        if (!src || (sameTarget(target, announced.current) && space === announcedSpace.current && section === announcedSection.current)) return undefined;
        announced.current = target;
        announcedSpace.current = space;
        announcedSection.current = section;
        if (section) return headerOverText(what(src, group), section, headerDropIds(section, draggedThreads(st), useThreadsStore.getState().byId).length);
        if (space) return `${what(src, group)} is over the space ${spaceName(space)}.`;
        if (group.length > 1) return target ? `${what(src, group)} is over ${targetText(src, target, names())}.` : `${what(src, group)} is over no place to drop.`;
        const effect = target ? modeDrop(snap.current?.scene ?? {}, src, target) : null;
        return overText(src, target, names(), effect ? modeDropOver(effect) : "");
      },
      onDragOver: () => undefined,
      onDragEnd: () => {
        const e = ended.current;
        if (!e) return undefined;
        if (e.section) return headerDroppedText(what(e.source, e.group), e.section);
        if (endedSpace.current) return `${what(e.source, e.group)} was moved to the space ${spaceName(endedSpace.current)}.`;
        if (e.group.length > 1) return e.target ? `${what(e.source, e.group)} was dropped on ${targetText(e.source, e.target, names())}.` : `${what(e.source, e.group)} was not opened.`;
        const effect = e.target ? modeDrop(snap.current?.scene ?? {}, e.source, e.target) : null;
        return droppedText(e.source, e.target, names(), effect ? modeDropDone(effect) : "");
      },
      onDragCancel: () => {
        const e = ended.current;
        if (!e) return undefined;
        return e.group.length > 1 ? `Moving ${groupText(e.group, names())} was cancelled.` : cancelledText(e.source, names());
      },
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
