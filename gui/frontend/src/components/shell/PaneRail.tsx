import { useEffect, useRef } from "react";
import { Maximize2 } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { focusTabNow } from "@/shell/commands";
import { usePaneDragged } from "@/shell/drag/state";
import { useTabDrag } from "@/shell/drag/draggable";
import { enterFullscreen } from "@/shell/fullscreen";
import type { PaneRect } from "@/shell/geometry/types";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { usePane, useTab, type TabEntry } from "@/stores/layout";
import { requestPaneFocus, useShellViewStore } from "@/stores/shellView";
import { AttentionDot, LinkedTip, TabContentIcon } from "./PaneTabStrip";
import { PaneExpandButton } from "./PaneCollapseButton";

/** One tab of a rail: its icon, the selected one marked, its attention dot; a click unfolds the pane on it. */
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
    <Tip label={linked ? <LinkedTip tab={tab} tabName={title} cut /> : title} side={vertical ? "right" : "bottom"}>
      <button
        ref={setNodeRef}
        {...listeners}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-label={title}
        aria-describedby={describedBy}
        tabIndex={selected ? 0 : -1}
        data-testid="shell-rail-tab"
        data-tab-id={tabId}
        data-kind={tab.kind}
        data-active={selected || undefined}
        className={cn(
          "relative flex size-7 shrink-0 cursor-default items-center justify-center rounded-md outline-none focus-visible:ring-1 focus-visible:ring-cf-focus",
          // The selected tab: the strip's active tint, its icon at full contrast, and an accent bar on the rail's inner side.
          selected
            ? cn(
                "bg-cf-control-hover text-cf-text before:absolute before:rounded-full before:bg-cf-accent",
                vertical ? "before:inset-y-1.5 before:left-0 before:w-0.5" : "before:inset-x-1.5 before:bottom-0 before:h-0.5",
              )
            : "text-cf-text-muted hover:bg-cf-control-hover/40 hover:text-cf-text",
          dragging && "opacity-40",
        )}
        onClick={() => {
          void focusTabNow(tabId);
          requestPaneFocus(paneId);
        }}
      >
        <span className="relative flex">
          <TabContentIcon tab={tab} />
          {surface.useAttention && <AttentionDot use={surface.useAttention} tab={tab} />}
        </span>
        {/* The drag layer reads tab names here (ShellDnd measureStrips). */}
        <span className="sr-only" data-testid="shell-tab-label">
          {title}
        </span>
      </button>
    </Tip>
  );
}

/**
 * A pane folded to a rail (docs/notes/shell-model.md, "Small windows"): too little room to keep
 * every pane at its minimum, or the user collapsed it ("Collapsing a pane"), so this one shows
 * only its tabs' icons, the selected one marked, with their attention dots. It mounts no tab body
 * and holds no stream. A click on an icon focuses that tab, which unfolds the pane (another may
 * fold) and opens a collapsed one; a tab drags out like any tab, and the rail as a whole takes a
 * dropped tab (shell/drag/targets.ts). Its last buttons open it again when the user collapsed it,
 * and show the pane full screen. A collapsed pane may have the focus (a direction key reached
 * it): its border is the focused one and the keyboard goes to its selected icon. Vertical in a
 * row of panes, horizontal in a column. See docs/notes/shell-19-rails-fullscreen.md and
 * docs/notes/shell-25d-collapse.md.
 */
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
    if (request === 0) return;
    listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [request]);
  return (
    <section
      className={cn(
        "absolute flex overflow-hidden rounded-pane border bg-cf-surface shadow-xs",
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
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label="Tabs"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        className={cn("flex min-h-0 min-w-0 items-center gap-1 overflow-hidden p-0.5", vertical ? "flex-col" : "flex-row")}
      >
        {tabIds.map((id) => (
          <RailTab key={id} tabId={id} paneId={paneId} selected={id === pane?.active} vertical={vertical} />
        ))}
        <span aria-hidden className={cn("shrink-0 bg-cf-divider", vertical ? "my-0.5 h-px w-4" : "mx-0.5 h-4 w-px")} />
        {/* As in the strip: the collapsed pane's open control, then full screen. */}
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
      </div>
    </section>
  );
}
