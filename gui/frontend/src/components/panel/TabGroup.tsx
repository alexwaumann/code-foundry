import type { CSSProperties } from "react";
import { PANE_HEADER_HEIGHT } from "@/components/window/titleBand";
import { focusPanelGroup, groupAt, usePanelStore, usePanelPicking, type GroupIndex } from "@/stores/panel";
import { GroupBody } from "./GroupBody";
import { PanelExpand } from "./PanelExpand";
import { PanelToggle } from "./PanelToggle";
import { TabStrip } from "./TabStrip";

/**
 * A group's header: its tabs and "+" on the left and, in the group at the panel's
 * top-right corner (`controls`), the expand button and the toggle at the far right.
 * PANE_HEADER_HEIGHT (44px) like every content pane header (window/PaneHeader), so it
 * ends on the title band's bottom edge beside them (window/titleBand.ts). Like them it
 * drags the window: the empty space around the tabs does, each tab and both buttons are
 * `no-drag`. An unsplit panel without tabs has no strip (the body is the surface list);
 * a split panel's empty group shows its "+", highlighted, as its strip.
 */
function GroupHeader({ panelKey, group, split, focused, controls }: { panelKey: string; group: GroupIndex; split: boolean; focused: boolean; controls: boolean }) {
  const hasTabs = usePanelStore((s) => {
    const e = s.byKey[panelKey];
    return e !== undefined && groupAt(e, group).tabs.length > 0;
  });
  const label = split ? `Side panel tabs, ${group === 0 ? "first" : "second"} group` : "Side panel tabs";
  return (
    <div
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
      <GroupBody panelKey={panelKey} group={group} />
    </div>
  );
}
