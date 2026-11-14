import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type Ref, type SyntheticEvent } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tip } from "@/components/ui/tooltip";
import { PANE_HEADER_HEIGHT } from "@/components/window/titleBand";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { focusTabNow } from "@/shell/commands";
import { closeTabAsked } from "@/shell/closeTab";
import { fitTabs, TAB_ICON_WIDTH, type TabFit } from "@/shell/geometry/tabFit";
import { shellBodyDomId, shellTabDomId } from "@/shell/domIds";
import { usePaneDrag, useTabDrag } from "@/shell/drag/draggable";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import type { ShellSurface } from "@/shell/surfaces/types";
import { dropTabCut, setTabCut } from "@/shell/tabCut";
import { takeRenameAfterMenu, useTabRenameStore } from "@/shell/terminalActions";
import { useThreadName } from "@/shell/useThreadName";
import { usePane, useTab, type TabEntry } from "@/stores/layout";
import { PanePlusMenu } from "./PanePlusMenu";
import { Kbd } from "@/components/ui/kbd";
import { toggleFullscreen } from "@/shell/fullscreen";
import { TabNameField } from "./TerminalTab";
import { PaneCollapseButton } from "./PaneCollapseButton";

/** The active tab: full tint in the focused pane, lighter in the others (the side panel's tints). */
const ACTIVE_FOCUSED = "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50";
const ACTIVE_UNFOCUSED = "bg-cf-control-hover/40 text-cf-text dark:bg-cf-control-hover/25";

/** Gap between tabs and the strip's side padding, in px (gap-0.5, px-1.5). */
const TAB_GAP = 2;
const STRIP_PAD = 6;
/** The "+" button after the last tab (size-7). */
const PLUS_WIDTH = 28;
/** The full screen button at the strip's right end (size-7 and its gap); in full screen the exit control is wider. */
const FULL_WIDTH = 32;
/** The collapse control left of it, and the gap after it. */
const COLLAPSE_WIDTH = 30;
const EXIT_WIDTH = 150;

/** The attention dot on a tab's icon: its thread needs the user (docs/notes/shell-model.md, "In a pane"). */
export function AttentionDot({ use, tab }: { use: NonNullable<ShellSurface["useAttention"]>; tab: TabEntry }) {
  const on = use(tab);
  return on ? <span role="img" aria-label="Needs you" className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-cf-warning ring-1 ring-cf-surface" data-testid="shell-tab-attention" /> : null;
}

/** A tab's icon and name; `room` keeps the close button's width (measuring a tab's natural width). */
function TabContent({ tab, label, room }: { tab: TabEntry; label: TabFit["label"]; room: boolean }) {
  const surface = shellSurfaceOf(tab.kind);
  const title = surface.useTitle(tab);
  return (
    <>
      <span className="relative flex shrink-0">
        <TabContentIcon tab={tab} />
        {!room && surface.useAttention && <AttentionDot use={surface.useAttention} tab={tab} />}
      </span>
      <span className={cn("min-w-0", label === "icon" ? "sr-only" : "truncate")} data-testid="shell-tab-label">
        {title}
      </span>
      {surface.useUnsaved && <UnsavedDot use={surface.useUnsaved} tab={tab} measure={room} />}
      {room && <span className="size-4 shrink-0" aria-hidden />}
    </>
  );
}

/** The amber dot of a tab with unsaved work (a File tab editing), as the side panel's strip had it. */
function UnsavedDot({ use, tab, measure }: { use: (tab: TabEntry) => boolean; tab: TabEntry; measure: boolean }) {
  if (!use(tab)) return null;
  // The measuring copy keeps its room only.
  if (measure) return <span className="size-1.5 shrink-0" aria-hidden />;
  return <span role="img" aria-label="Unsaved edits" className="size-1.5 shrink-0 rounded-full bg-cf-warning" data-testid="tab-unsaved" />;
}

/** A tab's icon: its surface's, or one that follows the tab (a terminal's). */
export function TabContentIcon({ tab }: { tab: TabEntry }) {
  const surface = shellSurfaceOf(tab.kind);
  const TabIcon = surface.TabIcon;
  const Icon = surface.icon;
  return TabIcon ? <TabIcon tab={tab} className="size-3.5 shrink-0" /> : <Icon className="size-3.5 shrink-0" aria-hidden />;
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

/**
 * A linked tab's hover names its thread (the name is nowhere else in the strip): "Diff of
 * <thread>", after the tab's own name when that is cut short or hidden.
 */
export function LinkedTip({ tab, tabName, cut }: { tab: TabEntry; tabName: string; cut: boolean }) {
  const thread = useThreadName(tab.thread);
  const phrase = `${shellSurfaceOf(tab.kind).linkedNoun ?? tab.kind} of ${thread}`;
  return cut ? (
    <span className="flex flex-col">
      <span>{tabName}</span>
      <span className="text-cf-text-muted">{phrase}</span>
    </span>
  ) : (
    <>{phrase}</>
  );
}

type Handler = (e: SyntheticEvent) => void;

/** Each of `extra`'s handlers (dnd-kit's listeners) called after the one `props` has for the same event. */
function mergeHandlers(props: object, extra: object | undefined): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  const own = props as Record<string, unknown>;
  for (const [name, fn] of Object.entries(extra ?? {}) as [string, unknown][]) {
    if (typeof fn !== "function") continue;
    const next = fn as Handler;
    const first = own[name];
    out[name] =
      typeof first === "function"
        ? (e) => {
            (first as Handler)(e);
            next(e);
          }
        : next;
  }
  return out;
}

function ShellTabOf(props: { tab: TabEntry; active: boolean; paneFocused: boolean; fit: TabFit | undefined; focusable: boolean }) {
  const menu = shellSurfaceOf(props.tab.kind).tabMenu;
  if (!menu) return <ShellTabBox {...props} />;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ShellTabBox {...props} />
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          // A rename picked in the menu starts now, and its field takes the keyboard.
          if (takeRenameAfterMenu(props.tab.id)) e.preventDefault();
        }}
      >
        {menu(props.tab)}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The tab's element takes two sets of props: a context menu trigger's (Radix's Slot: its ref and
 * handlers, for a surface with `tabMenu`) and the drag's (dnd-kit's ref and pointer listener).
 * Both get the element and every event. While the tab's name is being edited it does not drag.
 */
function ShellTabBox({ tab, active, paneFocused, fit, focusable, ref: triggerRef, ...rest }: { tab: TabEntry; active: boolean; paneFocused: boolean; fit: TabFit | undefined; focusable: boolean; ref?: Ref<HTMLDivElement> } & HTMLAttributes<HTMLDivElement>) {
  const title = useTabTitle(tab);
  const { setNodeRef, listeners, describedBy, dragging } = useTabDrag(tab.id, tab.paneId);
  const label = fit?.label ?? "full";
  const icon = label === "icon";
  const renaming = useTabRenameStore((s) => s.tabId === tab.id);
  const handlers = mergeHandlers(rest, renaming ? undefined : listeners);
  const linked = tab.thread !== "" && tab.kind !== "thread";
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        if (typeof triggerRef === "function") triggerRef(el);
        else if (triggerRef) triggerRef.current = el;
      }}
      {...rest}
      {...handlers}
      role="presentation"
      data-testid="shell-tab"
      data-dragging={dragging || undefined}
      data-tab-id={tab.id}
      data-kind={tab.kind}
      data-active={active || undefined}
      data-label={label}
      className={cn(
        "group relative flex h-7 shrink-0 items-center rounded-md text-body-sm [--wails-draggable:no-drag]",
        icon ? "justify-center" : "pr-1",
        active ? (paneFocused ? ACTIVE_FOCUSED : ACTIVE_UNFOCUSED) : "text-cf-text-muted hover:bg-cf-control-hover/40 hover:text-cf-text",
        dragging && "opacity-40",
      )}
      style={fit ? { width: fit.width } : undefined}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // middle click closes, below
      }}
      onAuxClick={(e) => {
        if (e.button === 1) void closeTabAsked(tab.id);
      }}
    >
      <Tip label={linked ? <LinkedTip tab={tab} tabName={title} cut={label !== "full"} /> : title} whenTruncated={!linked} side="bottom">
        <button
          type="button"
          role="tab"
          id={shellTabDomId(tab.id)}
          aria-selected={active}
          aria-controls={active ? shellBodyDomId(tab.paneId) : undefined}
          aria-describedby={describedBy}
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
      {renaming && <TabNameField tab={tab} className="absolute inset-y-1 right-1 left-7" />}
      {!icon && !renaming && (
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
            onClick={() => void closeTabAsked(tab.id)}
          >
            <X className="size-3" aria-hidden />
          </button>
        </Tip>
      )}
    </div>
  );
}

/**
 * The strip's right end: full screen for this pane, or, while it is full screen, a labelled exit
 * with its key (Escape) so leaving is never a guess.
 */
function FullscreenButton({ paneId, on, pushed }: { paneId: string; on: boolean; pushed: boolean }) {
  if (on) {
    return (
      <button
        type="button"
        data-testid="shell-fullscreen-exit"
        className="ml-auto flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 text-body-sm text-cf-text-muted outline-none hover:bg-cf-control-hover/40 hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus [--wails-draggable:no-drag]"
        onClick={() => {
          toggleFullscreen(paneId);
        }}
      >
        <Minimize2 className="size-3.5" aria-hidden />
        Exit full screen
        <Kbd size="sm">esc</Kbd>
      </button>
    );
  }
  return (
    <Tip label="Full screen">
      <button
        type="button"
        aria-label="Full screen"
        data-testid="shell-fullscreen"
        className={cn(!pushed && "ml-auto", "flex size-7 shrink-0 cursor-default items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover/40 hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus [--wails-draggable:no-drag]")}
        onClick={() => {
          toggleFullscreen(paneId);
        }}
      >
        <Maximize2 className="size-3.5" aria-hidden />
      </button>
    </Tip>
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
 * under the strip by default. Any tab drags, and the strip's free space drags the whole pane
 * (components/shell/ShellDnd.tsx), so it no longer drags the window (the top bar does). The "+" after
 * the last tab opens the pane's menu of surfaces (PanePlusMenu) and is not part of the pane's grip.
 * The right end collapses the pane (PaneCollapseButton) and shows it full screen; in full screen it
 * is only the exit control (Escape too).
 */
export function PaneTabStrip({ paneId, focused, fullscreen = false }: { paneId: string; focused: boolean; fullscreen?: boolean }) {
  const pane = usePane(paneId);
  const tabIds = pane?.tabIds ?? [];
  const active = pane?.active ?? "";
  const stripRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState<TabFit[] | null>(null);
  const { setNodeRef: setPaneNode, listeners: paneListeners } = usePaneDrag(paneId);
  const key = tabIds.join(",");

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const row = measureRef.current;
    if (!strip || !row) return;
    const measure = () => {
      const z = zoomFactor();
      const ids = key ? key.split(",") : [];
      const widths = Array.from(row.children).map((c) => Math.ceil(c.getBoundingClientRect().width / z));
      // The "+" after the last tab keeps its room.
      const avail = strip.getBoundingClientRect().width / z - 2 * STRIP_PAD - TAB_GAP * widths.length - PLUS_WIDTH - (fullscreen ? EXIT_WIDTH : FULL_WIDTH + COLLAPSE_WIDTH);
      if (!(avail > 0)) return;
      const next = fitTabs({ widths, active: ids.indexOf(active), avail, iconWidth: TAB_ICON_WIDTH });
      setFits((prev) => (prev && sameFits(prev, next) ? prev : next));
      setTabCut(paneId, (next[ids.indexOf(active)]?.label ?? "full") !== "full");
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    for (const c of Array.from(row.children)) ro.observe(c);
    return () => {
      ro.disconnect();
    };
  }, [key, active, paneId, fullscreen]);
  useEffect(
    () => () => {
      dropTabCut(paneId);
    },
    [paneId],
  );

  return (
    <div
      ref={(el) => {
        stripRef.current = el;
        setPaneNode(el);
      }}
      {...paneListeners}
      role="tablist"
      aria-label="Tabs"
      aria-orientation="horizontal"
      data-testid="shell-tab-strip"
      className="relative flex shrink-0 items-center gap-0.5 overflow-hidden border-b border-cf-divider px-1.5 [--wails-draggable:no-drag]"
      style={{ height: PANE_HEADER_HEIGHT, paddingLeft: STRIP_PAD }}
      onKeyDown={onStripKeyDown}
    >
      {tabIds.map((id, i) => (
        <ShellTab key={id} tabId={id} active={id === active} paneFocused={focused} fit={fits?.[i]} focusable={id === active} />
      ))}
      <PanePlusMenu paneId={paneId} />
      {/* Collapse, then full screen, at the right end; in full screen only its exit. */}
      {!fullscreen && <PaneCollapseButton paneId={paneId} className="ml-auto" />}
      <FullscreenButton paneId={paneId} on={fullscreen} pushed={!fullscreen} />
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex" data-testid="shell-tab-measure">
        {tabIds.map((id) => (
          <MeasureTab key={id} tabId={id} />
        ))}
      </div>
    </div>
  );
}
