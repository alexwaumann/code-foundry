import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { PANE_HEADER_HEIGHT } from "@/components/window/titleBand";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { closeTabNow, focusTabNow } from "@/shell/commands";
import { fitTabs, TAB_ICON_WIDTH, type TabFit } from "@/shell/geometry/tabFit";
import { shellBodyDomId, shellTabDomId } from "@/shell/domIds";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { usePane, useTab, type TabEntry } from "@/stores/layout";

/** The active tab: full tint in the focused pane, lighter in the others (the side panel's tints). */
const ACTIVE_FOCUSED = "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50";
const ACTIVE_UNFOCUSED = "bg-cf-control-hover/40 text-cf-text dark:bg-cf-control-hover/25";

/** Gap between tabs and the strip's side padding, in px (gap-0.5, px-1.5). */
const TAB_GAP = 2;
const STRIP_PAD = 6;

/** A tab's icon and name; `room` keeps the close button's width (measuring a tab's natural width). */
function TabContent({ tab, label, room }: { tab: TabEntry; label: TabFit["label"]; room: boolean }) {
  const surface = shellSurfaceOf(tab.kind);
  const title = surface.useTitle(tab);
  const Icon = surface.icon;
  return (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className={cn("min-w-0", label === "icon" ? "sr-only" : "truncate")} data-testid="shell-tab-label">
        {title}
      </span>
      {room && <span className="size-4 shrink-0" aria-hidden />}
    </>
  );
}

/** A tab's name, for a close button's label and the tooltip (a hook per tab, so a thread's rename shows). */
function useTabTitle(tab: TabEntry): string {
  return shellSurfaceOf(tab.kind).useTitle(tab);
}

/**
 * One tab of the strip: a click focuses it (its pane too), the × or a middle click closes it
 * (tab.close: a thread's tab closes the thread from the space). The active tab shows its whole
 * name while it fits; the others shorten first; tight, tabs go icon-only (tabFit). The tooltip
 * shows the name only while it is cut off or hidden.
 */
function ShellTab({ tabId, active, paneFocused, fit, focusable }: { tabId: string; active: boolean; paneFocused: boolean; fit: TabFit | undefined; focusable: boolean }) {
  const tab = useTab(tabId);
  if (!tab) return null;
  return <ShellTabOf tab={tab} active={active} paneFocused={paneFocused} fit={fit} focusable={focusable} />;
}

function ShellTabOf({ tab, active, paneFocused, fit, focusable }: { tab: TabEntry; active: boolean; paneFocused: boolean; fit: TabFit | undefined; focusable: boolean }) {
  const title = useTabTitle(tab);
  const label = fit?.label ?? "full";
  const icon = label === "icon";
  return (
    <div
      role="presentation"
      data-testid="shell-tab"
      data-tab-id={tab.id}
      data-kind={tab.kind}
      data-active={active || undefined}
      data-label={label}
      className={cn(
        "group relative flex h-7 shrink-0 items-center rounded-md text-body-sm [--wails-draggable:no-drag]",
        icon ? "justify-center" : "pr-1",
        active ? (paneFocused ? ACTIVE_FOCUSED : ACTIVE_UNFOCUSED) : "text-cf-text-muted hover:bg-cf-control-hover/40 hover:text-cf-text",
      )}
      style={fit ? { width: fit.width } : undefined}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // middle click closes, below
      }}
      onAuxClick={(e) => {
        if (e.button === 1) void closeTabNow(tab.id);
      }}
    >
      <Tip label={title} whenTruncated side="bottom">
        <button
          type="button"
          role="tab"
          id={shellTabDomId(tab.id)}
          aria-selected={active}
          aria-controls={active ? shellBodyDomId(tab.paneId) : undefined}
          tabIndex={focusable ? 0 : -1}
          className={cn(
            "flex h-full min-w-0 flex-1 cursor-default items-center gap-1.5 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-cf-focus",
            icon ? "justify-center px-1" : "pr-1 pl-2",
          )}
          onClick={() => {
            if (!active || !paneFocused) void focusTabNow(tab.id);
          }}
        >
          <TabContent tab={tab} label={label} room={false} />
        </button>
      </Tip>
      {!icon && (
        <Tip label="Close tab">
          <button
            type="button"
            tabIndex={focusable ? 0 : -1}
            aria-label={`Close ${title}`}
            data-testid="shell-tab-close"
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-cf-text/10 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-cf-focus",
              active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
            onClick={() => void closeTabNow(tab.id)}
          >
            <X className="size-3" aria-hidden />
          </button>
        </Tip>
      )}
    </div>
  );
}

/** A tab at its natural width, for measuring: the same content and padding, never shortened. */
function MeasureTab({ tabId }: { tabId: string }) {
  const tab = useTab(tabId);
  if (!tab) return <span />;
  return (
    <span className="flex h-7 shrink-0 items-center gap-1.5 pr-1 pl-2 text-body-sm whitespace-nowrap" data-measure-tab={tabId}>
      <TabContent tab={tab} label="full" room />
    </span>
  );
}

function sameFits(a: readonly TabFit[], b: readonly TabFit[]): boolean {
  return a.length === b.length && a.every((f, i) => f.label === b.at(i)?.label && f.width === b.at(i)?.width);
}

/** Left/Right (and Home/End) move between the tabs; Enter or Space on a tab activates it. */
function onStripKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const i = tabs.findIndex((t) => t === document.activeElement || t.parentElement?.contains(document.activeElement));
  if (i < 0) return;
  const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
  if (next < 0) return;
  e.preventDefault();
  e.stopPropagation();
  tabs[next]?.focus();
}

/**
 * A pane's tab strip: the tab is the title (docs/notes/shell-model.md), so nothing repeats it
 * under the strip by default. The strip's free space drags the window until the top bar does
 * (PR 15). `inset` keeps the strip clear of the traffic lights (the pane at the window's top left
 * with the sidebar hidden). The "+" menu (PR 12), drags (PR 14) and full screen (PR 19) come later.
 */
export function PaneTabStrip({ paneId, focused, inset = 0 }: { paneId: string; focused: boolean; inset?: number }) {
  const pane = usePane(paneId);
  const tabIds = pane?.tabIds ?? [];
  const active = pane?.active ?? "";
  const stripRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState<TabFit[] | null>(null);
  const key = tabIds.join(",");

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const row = measureRef.current;
    if (!strip || !row) return;
    const measure = () => {
      const z = zoomFactor();
      const ids = key ? key.split(",") : [];
      const widths = Array.from(row.children).map((c) => Math.ceil(c.getBoundingClientRect().width / z));
      const avail = strip.getBoundingClientRect().width / z - 2 * STRIP_PAD - inset - TAB_GAP * Math.max(0, widths.length - 1);
      if (!(avail > 0)) return;
      const next = fitTabs({ widths, active: ids.indexOf(active), avail, iconWidth: TAB_ICON_WIDTH });
      setFits((prev) => (prev && sameFits(prev, next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    for (const c of Array.from(row.children)) ro.observe(c);
    return () => {
      ro.disconnect();
    };
  }, [key, active, inset]);

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Tabs"
      aria-orientation="horizontal"
      data-testid="shell-tab-strip"
      className="relative flex shrink-0 items-center gap-0.5 overflow-hidden border-b border-cf-divider px-1.5 [--wails-draggable:drag]"
      style={{ height: PANE_HEADER_HEIGHT, paddingLeft: STRIP_PAD + inset }}
      onKeyDown={onStripKeyDown}
    >
      {tabIds.map((id, i) => (
        <ShellTab key={id} tabId={id} active={id === active} paneFocused={focused} fit={fits?.[i]} focusable={id === active} />
      ))}
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex" data-testid="shell-tab-measure">
        {tabIds.map((id) => (
          <MeasureTab key={id} tabId={id} />
        ))}
      </div>
    </div>
  );
}
