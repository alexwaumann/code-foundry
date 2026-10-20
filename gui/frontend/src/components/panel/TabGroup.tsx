import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { PANE_HEADER_HEIGHT } from "@/components/window/titleBand";
import { cn } from "@/lib/utils";
import { focusPanelGroup, groupAt, usePanelStore, usePanelPicking, type GroupIndex } from "@/stores/panel";
import { BAND_DROP_ID, bodyDropId, headerDropId } from "./dragDrop";
import { GroupBody } from "./GroupBody";
import { usePanelDrop } from "./panelDrop";
import { PanelExpand } from "./PanelExpand";
import { PanelToggle } from "./PanelToggle";
import type { SplitOrientation } from "./splitLayout";
import { TabStrip } from "./TabStrip";

/**
 * A group's header: its tabs and "+" on the left and, in the group at the panel's
 * top-right corner (`controls`), the expand button and the toggle at the far right.
 * PANE_HEADER_HEIGHT (44px) like every content pane header (window/PaneHeader), so it
 * ends on the title band's bottom edge beside them (window/titleBand.ts). Like them it
 * drags the window: the empty space around the tabs does, each tab and both buttons are
 * `no-drag`. An unsplit panel without tabs has no strip (the body is the surface list);
 * a split panel's empty group shows its "+", highlighted, as its strip. The header is a
 * drop target for a dragged tab (dragDrop.ts): in its own group's it reorders, in the
 * other group's it lands at the slot under the pointer.
 */
function GroupHeader({ panelKey, group, split, focused, controls }: { panelKey: string; group: GroupIndex; split: boolean; focused: boolean; controls: boolean }) {
  const hasTabs = usePanelStore((s) => {
    const e = s.byKey[panelKey];
    return e !== undefined && groupAt(e, group).tabs.length > 0;
  });
  const label = split ? `Side panel tabs, ${group === 0 ? "first" : "second"} group` : "Side panel tabs";
  const data = useMemo(() => ({ kind: "header", group }), [group]);
  const { setNodeRef } = useDroppable({ id: headerDropId(group), data });
  return (
    <div
      ref={setNodeRef}
      className="flex shrink-0 items-center gap-2 border-b border-pane-border pr-2 pl-1.5 [--wails-draggable:drag]"
      style={{ height: PANE_HEADER_HEIGHT }}
      data-testid="panel-header"
    >
      {hasTabs || split ? <TabStrip panelKey={panelKey} group={group} focused={focused} label={label} /> : <div className="min-w-0 flex-1" />}
      {controls && (
        <span className="flex shrink-0 items-center gap-0.5" data-testid="panel-controls">
          <PanelExpand />
          <PanelToggle inPanel />
        </span>
      )}
    </div>
  );
}

/**
 * The far edge of an unsplit panel's body while one of its two or more tabs is dragged:
 * the right 45% side by side, the bottom 45% stacked (where the second group would
 * appear), 8px in from the body's edges. A drop on it splits the panel with that tab in
 * the second group. Faint until the pointer is over it.
 */
function DropBand({ side, over }: { side: SplitOrientation; over: boolean }) {
  const data = useMemo(() => ({ kind: "band" }), []);
  const { setNodeRef } = useDroppable({ id: BAND_DROP_ID, data });
  return (
    <div
      ref={setNodeRef}
      aria-hidden
      data-testid="panel-drop-band"
      data-side={side}
      data-over={over || undefined}
      className={cn(
        "pointer-events-none absolute z-10 rounded-lg ring-1 ring-inset transition-colors duration-150",
        side === "side" ? "inset-y-2 right-2 left-[55%]" : "inset-x-2 top-[55%] bottom-2",
        over ? "bg-accent/55 ring-ring" : "bg-accent/20 ring-ring/40",
      )}
    />
  );
}

/**
 * A group's body as a drop target: while split, a tab of the other group dropped on it
 * moves here, last, and the body is tinted while one is over it. Unsplit, it holds the
 * drop band while a tab is dragged, with two or more tabs (a lone tab has nothing to
 * split from).
 */
function GroupDropArea({ panelKey, group, split, children }: { panelKey: string; group: GroupIndex; split: boolean; children: ReactNode }) {
  const { drag, target, band } = usePanelDrop();
  const data = useMemo(() => ({ kind: "body", group }), [group]);
  const { setNodeRef } = useDroppable({ id: bodyDropId(group), data, disabled: !split });
  const many = usePanelStore((s) => {
    const e = s.byKey[panelKey];
    return e !== undefined && groupAt(e, group).tabs.length > 1;
  });
  return (
    <div ref={setNodeRef} className="relative flex min-h-0 flex-1 flex-col">
      {children}
      {split && target?.kind === "body" && target.group === group && <div aria-hidden data-testid="panel-drop-tint" className="pointer-events-none absolute inset-0 z-10 bg-accent/30" />}
      {!split && drag !== null && many && <DropBand side={band} over={target?.kind === "band"} />}
    </div>
  );
}

/**
 * One tab group of the side panel: its header (strip, "+", and maybe the panel's
 * buttons) over its body. An unsplit panel is one group. In a split panel a press or
 * focus anywhere inside a group makes it the focused group (focusPanelGroup), which the
 * panel's keys, view.panel.new-tab and new tabs act on; its active tab has the full tint,
 * the other group's a lighter one. A split group is focusable itself (tabIndex -1), so
 * cmd+alt+\ can move focus into the other group whatever it shows.
 *
 * `data-panel-group` is the index, `data-focused` marks the focused group of a split
 * panel and `data-picking` a group showing its surface list.
 */
export function TabGroup({ panelKey, group, split, focused, controls, style }: { panelKey: string; group: GroupIndex; split: boolean; focused: boolean; controls: boolean; style?: CSSProperties }) {
  const picking = usePanelPicking(panelKey, group);
  const focus = () => {
    if (split && !focused) focusPanelGroup(panelKey, group);
  };
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      style={style}
      tabIndex={split ? -1 : undefined}
      data-panel-group={group}
      data-focused={(split && focused) || undefined}
      data-picking={picking || undefined}
      data-testid="panel-group"
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      <GroupHeader panelKey={panelKey} group={group} split={split} focused={focused} controls={controls} />
      <GroupDropArea panelKey={panelKey} group={group} split={split}>
        <GroupBody panelKey={panelKey} group={group} />
      </GroupDropArea>
    </div>
  );
}
