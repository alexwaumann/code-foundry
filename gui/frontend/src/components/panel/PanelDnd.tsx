import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type ScreenReaderInstructions } from "@dnd-kit/core";
import { allTabs, getPanel, groupAt, groupOf, movePanelTab, type Tab } from "@/stores/panel";
import { surfaceOf } from "@/surfaces/registry";
import { moveTabToGroup } from "./actions";
import { tabAnnouncer } from "./announcements";
import { dropDataOf, dropMove, dropTargetOf, panelCollision, restrictTo, sameTarget, type DropTarget } from "./dragDrop";
import { PanelDropContext, type PanelDrag, type PanelDropState } from "./panelDrop";
import type { SplitOrientation } from "./splitLayout";

/** What a tab's aria-describedby reads: the keyboard way to move it in its strip, and the drag to the other group or the panel's edge. */
const screenReaderInstructions: ScreenReaderInstructions = {
  draggable: "To move this tab, press Option with Left Arrow or Right Arrow. Drag it onto the other group to move it there, or onto the far edge of the panel to split it.",
};

/**
 * Scrolling a strip while a tab is dragged near its edge: only strips (dnd-kit would
 * also scroll a body), only sideways, and slower than dnd-kit's default (10), which
 * crossed a dozen tabs in half a second. dnd-kit scrolls the ancestors of what the tab
 * is over: its own strip, or the other group's when it is over a tab there.
 */
const autoScroll = { acceleration: 4, threshold: { x: 0.2, y: 0 }, canScroll: (el: Element) => el.getAttribute("role") === "tablist" };

/** The lifted tab: a copy of it on the popover background with a shadow, under the pointer. Not a tab to assistive tech. */
function TabGhost({ tab }: { tab: Tab }) {
  const Icon = surfaceOf(tab.kind)?.icon;
  return (
    <div
      aria-hidden
      data-testid="panel-tab-ghost"
      className="flex size-full items-center gap-1.5 rounded-md bg-popover pr-3 pl-2 text-body-sm text-popover-foreground shadow-md ring-1 ring-border [--wails-draggable:no-drag]"
    >
      {Icon && <Icon className="size-3.5 shrink-0" />}
      <span className="truncate">{tab.title}</span>
    </div>
  );
}

/**
 * The side panel's one DndContext, around both groups: a tab dragged from either strip
 * can reorder its own strip, land in the other group's strip or body, or (unsplit, with
 * two or more tabs) on the drop band that splits the panel (dragDrop.ts). The lifted tab
 * is a DragOverlay ghost kept inside the panel; its slot in the strip stays, dimmed, and
 * slides to where a reorder would put it. A drop anywhere else puts it back.
 *
 * `orientation` is the panel's (splitOrientation): the band's edge while unsplit.
 * `panel` is the aside, the ghost's bounds. `onDragChange` hears a tab lifted (true) and
 * dropped or cancelled (false): the aside marks the drag for its iframes (Panel).
 */
export function PanelDnd({
  panelKey,
  orientation,
  panel,
  onDragChange,
  children,
}: {
  panelKey: string;
  orientation: SplitOrientation;
  panel: RefObject<HTMLElement | null>;
  onDragChange?: (dragging: boolean) => void;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<PanelDrag | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  // dnd-kit's sensor outlives the context: a release after the panel unmounted (the
  // selection switched mid-drag) still ends the drag here. Its panel is gone: no move.
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A drag starts after 4px of travel, so a click (and the ×, and middle click) is still a click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const announcer = useMemo(() => tabAnnouncer(panelKey), [panelKey]);
  const modifiers = useMemo(
    () => [
      restrictTo(() => {
        const r = panel.current?.getBoundingClientRect();
        return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
      }),
    ],
    [panel],
  );

  const track = ({ collisions }: DragMoveEvent) => {
    const t = dropTargetOf(collisions);
    announcer.track(t);
    setTarget((prev) => (sameTarget(prev, t) ? prev : t));
  };
  const end = () => {
    setDrag(null);
    setTarget(null);
    onDragChange?.(false);
  };
  const onDragStart = ({ active }: DragStartEvent) => {
    announcer.track(null);
    const d = dropDataOf(active.data.current);
    const tab = allTabs(getPanel(panelKey)).find((t) => t.id === active.id);
    if (d?.kind !== "tab" || !tab) return;
    setDrag({ tab, group: d.group });
    onDragChange?.(true);
  };
  const onDragEnd = ({ active, collisions }: DragEndEvent) => {
    end();
    if (!alive.current) return;
    const id = String(active.id);
    const e = getPanel(panelKey);
    // The store as it is now: a tab opened or closed mid-drag counts, and a closed dragged tab moves nothing.
    const g = groupOf(e, id);
    if (g === null) return;
    const t = dropTargetOf(collisions);
    announcer.track(t);
    const move = dropMove(
      t,
      id,
      groupAt(e, g).tabs.map((x) => x.id),
    );
    if (move?.kind === "reorder") movePanelTab(panelKey, id, move.to);
    else if (move) moveTabToGroup(panelKey, id, move.group, move.index);
  };

  const state = useMemo<PanelDropState>(() => ({ drag, target, band: orientation }), [drag, target, orientation]);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={panelCollision}
      modifiers={modifiers}
      accessibility={{ announcements: announcer.announcements, screenReaderInstructions }}
      autoScroll={autoScroll}
      onDragStart={onDragStart}
      onDragMove={track}
      onDragOver={track}
      onDragEnd={onDragEnd}
      onDragCancel={end}
    >
      <PanelDropContext.Provider value={state}>{children}</PanelDropContext.Provider>
      {/* In document.body, so no panel box clips it; the ghost is kept inside the panel by the
          modifier. It never takes the pointer: after a drop it flies back over the tab for 250ms,
          and a press on the tab then would land on the ghost and start nothing. */}
      {createPortal(
        <DragOverlay className="pointer-events-none">
          {drag ? <TabGhost tab={drag.tab} /> : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
