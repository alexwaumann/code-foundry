import { useEffect, useRef, type MouseEvent } from "react";
import { Maximize2 } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { openPane } from "@/shell/collapse";
import { focusTabNow } from "@/shell/commands";
import { usePaneDragged } from "@/shell/drag/state";
import { useTabDrag } from "@/shell/drag/draggable";
import { enterFullscreen } from "@/shell/fullscreen";
import type { PaneRect } from "@/shell/geometry/types";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { useLayoutStore, usePane, useTab, type TabEntry } from "@/stores/layout";
import { requestPaneFocus, takeFocusRequest, useShellViewStore } from "@/stores/shellView";
import { keepPreviewTab } from "@/shell/preview";
import { LinkedTip, StatusDot, PREVIEW_DASHES, TabContentIcon, TabContextMenu } from "./PaneTabStrip";
import { PaneExpandButton } from "./PaneCollapseButton";

/**
 * One tab of a rail: its icon, the selected one marked, its attention dot; a click unfolds the
 * pane on it. A preview has a dashed square around its icon, and a double click keeps it. A right
 * click shows the tab's menu, as on its strip (a thread's, a terminal's).
 */
function RailTab({ tabId, paneId, selected, vertical }: { tabId: string; paneId: string; selected: boolean; vertical: boolean }) {
  const tab = useTab(tabId);
  return tab ? <RailTabOf tab={tab} paneId={paneId} selected={selected} vertical={vertical} /> : null;
}

function RailTabOf({ tab, paneId, selected, vertical }: { tab: TabEntry; paneId: string; selected: boolean; vertical: boolean }) {
  const tabId = tab.id;
  const surface = shellSurfaceOf(tab.kind);
  const title = surface.useTitle(tab);
  const { setNodeRef, listeners, describedBy, dragging } = useTabDrag(tabId, paneId);
  const linked = tab.thread !== "" && tab.kind !== "thread";
  return (
    // The name is nowhere on screen: the tooltip names the tab (a linked one, its thread too).
    <TabContextMenu
      tab={tab}
      wrap={(trigger) => (
        <Tip label={linked ? <LinkedTip tab={tab} tabName={title} cut /> : title} side={vertical ? "right" : "bottom"}>
          {trigger}
        </Tip>
      )}
    >
      <button
        ref={setNodeRef}
        {...listeners}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-label={tab.preview ? `${title}, preview` : title}
        aria-describedby={describedBy}
        tabIndex={selected ? 0 : -1}
        data-testid="shell-rail-tab"
        data-tab-id={tabId}
        data-kind={tab.kind}
        data-active={selected || undefined}
        data-preview={tab.preview || undefined}
        className={cn(
          "relative flex size-7 shrink-0 cursor-default items-center justify-center rounded-md outline-none focus-visible:ring-1 focus-visible:ring-cf-focus",
          // The selected tab: the strip's active tint (a step stronger while the whole rail is
          // hovered, so it stays apart from the rail's tint), its icon at full contrast, and an accent
          // bar on the rail's inner side.
          selected
            ? cn(
                "bg-cf-control-hover text-cf-text group-hover/rail:bg-cf-control-active before:absolute before:rounded-full before:bg-cf-accent",
                vertical ? "before:inset-y-1.5 before:left-0 before:w-0.5" : "before:inset-x-1.5 before:bottom-0 before:h-0.5",
              )
            : "text-cf-text-muted hover:bg-cf-control-hover/40 hover:text-cf-text",
          // A preview: the strip's dashed square around the icon.
          tab.preview && PREVIEW_DASHES,
          dragging && "opacity-40",
        )}
        onClick={() => {
          void focusTabNow(tabId);
          requestPaneFocus(paneId);
        }}
        onDoubleClick={() => {
          if (tab.preview) void keepPreviewTab(tabId);
        }}
      >
        <span className="relative flex">
          <TabContentIcon tab={tab} />
          {surface.useStatus && <StatusDot use={surface.useStatus} tab={tab} />}
        </span>
        {/* The drag layer reads tab names here (ShellDnd measureStrips). */}
        <span className="sr-only" data-testid="shell-tab-label">
          {title}
        </span>
      </button>
    </TabContextMenu>
  );
}

/**
 * A pane folded to a rail (docs/notes/shell-model.md, "Small windows"): too little room to keep
 * every pane at its minimum, or the user collapsed it ("Collapsing a pane"), so this one shows
 * only its tabs' icons, the selected one marked, with their status dots. It mounts no tab body
 * and holds no stream. A click on an icon focuses that tab, which unfolds the pane (another may
 * fold) and opens a collapsed one; a click anywhere else on the rail that is not one of its
 * buttons opens it on its selected tab (openRail), and the whole rail tints under the pointer to
 * say so; a tab drags out like any tab, and the rail as a whole takes a
 * dropped tab (shell/drag/targets.ts). Its last buttons open it again when the user collapsed it,
 * and show the pane full screen; a horizontal rail has them at its right end, where the open
 * pane's strip has collapse and full screen. A collapsed pane may have the focus (a direction key reached
 * it): its border is the focused one and the keyboard goes to its selected icon. Vertical in a
 * row of panes, horizontal in a column. See docs/notes/shell-19-rails-fullscreen.md and
 * docs/notes/shell-25d-collapse.md.
 */
/**
 * A click on the rail's empty area (anywhere but an icon or a button): the pane opens on its
 * selected tab, with the focus. A pane the user collapsed opens as its Expand pane button does; a
 * pane folded for lack of room as a click on its selected icon does (that tab takes the focus, so
 * the pane unfolds and another may fold). A click that bubbles here through React from a portal
 * (a tab's context menu) is not on the rail and does nothing; after a tab drag dnd-kit swallows
 * the click, so a drag never reads as one.
 */
function openRail(e: MouseEvent<HTMLElement>, paneId: string): void {
  const target = e.target as Element;
  if (!e.currentTarget.contains(target) || target.closest("button")) return;
  const pane = useLayoutStore.getState().panes[paneId];
  if (!pane) return;
  if (pane.collapsed) {
    void openPane(paneId);
    return;
  }
  if (!pane.active) return;
  void focusTabNow(pane.active);
  requestPaneFocus(paneId);
}

export function PaneRail({ paneId, rect, focused = false }: { paneId: string; rect: PaneRect; focused?: boolean }) {
  const pane = usePane(paneId);
  const dragged = usePaneDragged(paneId);
  const vertical = rect.h >= rect.w;
  const tabIds = pane?.tabIds ?? [];
  const collapsed = pane?.collapsed ?? false;
  const listRef = useRef<HTMLDivElement>(null);
  const request = useShellViewStore((s) => (s.focusRequest.paneId === paneId ? s.focusRequest.seq : 0));
  useEffect(() => {
    // A focus request (a direction key, a collapse that left the focus here) puts the keyboard on the selected icon.
    // Served once: a rail that mounts later (the pane folds) leaves the keyboard where it is.
    if (!listRef.current || !takeFocusRequest(request, "rail")) return;
    listRef.current.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [request]);
  return (
    // The whole rail is the pointer's target (openRail); the keyboard keeps to the tablist's icons
    // and buttons, so the rail adds no tab stop and no role.
    <section
      className={cn(
        "group/rail absolute flex overflow-hidden rounded-pane border bg-cf-surface shadow-xs",
        focused ? "border-cf-accent/60" : "border-cf-divider",
        dragged && "opacity-60",
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      aria-label={collapsed ? "Collapsed pane" : "Folded pane"}
      data-testid="shell-rail"
      data-pane-id={paneId}
      data-collapsed={collapsed || undefined}
      data-focused={focused || undefined}
      data-orientation={vertical ? "vertical" : "horizontal"}
      onClick={(e) => {
        openRail(e, paneId);
      }}
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label="Tabs"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        // It fills the rail, so its tint (the control hover at low strength) covers the whole rail
        // while the pointer is anywhere on it.
        className={cn(
          "flex min-h-0 min-w-0 w-full items-center gap-1 overflow-hidden group-hover/rail:bg-cf-control-hover/40",
          vertical ? "flex-col p-0.5" : "flex-row py-0.5 pr-1.5 pl-0.5",
        )}
      >
        {tabIds.map((id) => (
          <RailTab key={id} tabId={id} paneId={paneId} selected={id === pane?.active} vertical={vertical} />
        ))}
        {/* In a row of panes: a divider, then the controls under the icons. */}
        {vertical && <span aria-hidden className="my-0.5 h-px w-4 shrink-0 bg-cf-divider" />}
        {/*
          As in the strip: the collapsed pane's open control, then full screen. A horizontal rail
          keeps them at its right end, at the strip's spacing, so they sit where the open pane's
          collapse and full screen controls were.
        */}
        <span className={cn("flex shrink-0 items-center", vertical ? "flex-col gap-1" : "ml-auto gap-0.5")} data-testid="shell-rail-controls">
          {collapsed && <PaneExpandButton paneId={paneId} vertical={vertical} />}
          <Tip label="Full screen" side={vertical ? "right" : "bottom"}>
            <button
              type="button"
              aria-label="Full screen"
              data-testid="shell-rail-fullscreen"
              className="flex size-7 shrink-0 cursor-default items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover/40 hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
              onClick={() => {
                enterFullscreen(paneId);
              }}
            >
              <Maximize2 className="size-3.5" aria-hidden />
            </button>
          </Tip>
        </span>
      </div>
    </section>
  );
}
