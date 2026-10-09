import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";
import { X } from "lucide-react";
import { chordFromEvent } from "@/keys/chord";
import { cn } from "@/lib/utils";
import { activatePanelTab, closePanelTab, emptyEntry, getPanel, openSurface, togglePanel, useCurrentPanelKey, usePanelExpanded, usePanelStore, usePanelWidth, type Tab } from "@/stores/panel";
import { PANEL_MIN, panelMax, useUiStore, visibleSidebarWidth } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { surfaceOf, surfaces, useAvailability, type SurfaceContext, type SurfaceSpec } from "@/surfaces/registry";
import { PanelExpand } from "./PanelExpand";
import { PanelToggle } from "./PanelToggle";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { isPanelChord, panelKeyAction } from "./keys";
import { revealTab } from "./reveal";

const BODY_ID = "side-panel-body";

function isEditable(el: EventTarget): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);
}

function surfaceContext(panelKey: string): SurfaceContext {
  return { selection: useUiStore.getState().selection, panelKey };
}

/**
 * Closing the panel's last tab hides it. If it had focus, hand focus to the content
 * pane (its terminal, or the page's focus root), so keys keep working.
 */
function closeTab(panelKey: string, id: string): void {
  const hadFocus = useUiStore.getState().focus === "panel";
  closePanelTab(panelKey, id);
  if (hadFocus && !getPanel(panelKey).open) useUiStore.getState().focusContent();
}

/** Hides the panel (cmd+w with no tabs) and gives focus to the content pane. */
function hidePanel(panelKey: string): void {
  togglePanel(panelKey, false);
  useUiStore.getState().focusContent();
}

function tabDomId(id: string): string {
  return `panel-tab-${encodeURIComponent(id)}`;
}

function TabButton({ panelKey, tab, active }: { panelKey: string; tab: Tab; active: boolean }) {
  const Icon = surfaceOf(tab.kind)?.icon;
  return (
    <div
      role="presentation"
      data-tab-id={tab.id}
      className={cn(
        "group flex h-7 max-w-48 shrink-0 items-center rounded-md pr-1 text-xs [--wails-draggable:no-drag]",
        active ? "bg-accent text-accent-foreground dark:bg-accent/50" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // middle click closes, below
      }}
      onAuxClick={(e) => {
        if (e.button === 1) closeTab(panelKey, tab.id);
      }}
    >
      {/* Roving tabindex: Tab reaches the active tab (and its ×); arrows move between tabs. */}
      <button
        type="button"
        role="tab"
        id={tabDomId(tab.id)}
        aria-selected={active}
        aria-controls={active ? BODY_ID : undefined}
        tabIndex={active ? 0 : -1}
        className="flex h-full min-w-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => {
          activatePanelTab(panelKey, tab.id);
        }}
      >
        {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
        <span className="truncate">{tab.title}</span>
      </button>
      <button
        type="button"
        tabIndex={active ? 0 : -1}
        aria-label={`Close ${tab.title}`}
        title="Close tab"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-foreground/10 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        onClick={() => {
          closeTab(panelKey, tab.id);
        }}
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}

/** Left/Right (and Home/End) move focus between tabs; Enter or Space on a tab activates it. */
function onTabListKeyDown(e: KeyboardEvent<HTMLElement>): void {
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

function TabStrip({ panelKey }: { panelKey: string }) {
  const tabs = usePanelStore((s) => s.byKey[panelKey]?.tabs ?? emptyEntry.tabs);
  const activeTabId = usePanelStore((s) => s.byKey[panelKey]?.activeTabId ?? null);
  const stripRef = useRef<HTMLDivElement>(null);
  // A new or activated tab may sit past the strip's scrolled edge (e.g. a PR row opened
  // its tenth tab): bring it into view.
  useEffect(() => {
    if (stripRef.current && activeTabId !== null) revealTab(stripRef.current, activeTabId);
  }, [activeTabId, tabs.length]);
  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Side panel tabs"
      aria-orientation="horizontal"
      className="relative flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      data-testid="panel-tabs"
      onKeyDown={onTabListKeyDown}
    >
      {tabs.map((t) => (
        <TabButton key={t.id} panelKey={panelKey} tab={t} active={t.id === activeTabId} />
      ))}
    </div>
  );
}

/** One entry of the empty list. Its availability is a hook, so it follows the stores the surface reads. */
function SurfaceRow({ spec, ctx }: { spec: SurfaceSpec; ctx: SurfaceContext }) {
  const availability = useAvailability(spec, ctx);
  if (availability === "hidden") return null;
  const enabled = availability === "enabled";
  return (
    <li>
      <button
        type="button"
        disabled={!enabled}
        data-surface={spec.kind}
        data-availability={availability}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm enabled:hover:bg-accent disabled:cursor-default disabled:opacity-45"
        onClick={() => {
          const now = surfaceContext(ctx.panelKey);
          const tab = spec.openDefault(now);
          if (tab && spec.available(now) === "enabled") openSurface(ctx.panelKey, tab);
        }}
      >
        <spec.icon className="size-4 text-muted-foreground" aria-hidden />
        <span className="flex-1 truncate">{spec.title}</span>
        <kbd className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground">{spec.hotkey.toUpperCase()}</kbd>
      </button>
    </li>
  );
}

/** No tabs yet: the surfaces this selection can open, with their hotkeys (as in T3 Code). */
function EmptyState({ panelKey }: { panelKey: string }) {
  const selection = useUiStore((s) => s.selection);
  const ctx = useMemo<SurfaceContext>(() => ({ selection, panelKey }), [selection, panelKey]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6" data-testid="panel-empty">
      <div className="w-full max-w-64">
        <h2 className="mb-3 text-center text-sm font-medium">Open a surface</h2>
        <ul className="flex flex-col gap-0.5">
          {surfaces.map((spec) => (
            <SurfaceRow key={spec.kind} spec={spec} ctx={ctx} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function Body({ panelKey }: { panelKey: string }) {
  const active = usePanelStore((s) => {
    const e = s.byKey[panelKey];
    return e?.tabs.find((t) => t.id === e.activeTabId) ?? null;
  });
  if (!active) return <EmptyState panelKey={panelKey} />;
  const spec = surfaceOf(active.kind);
  return (
    // Keyed by tab: switching tabs of the same kind must not reuse the other tab's state.
    <div
      key={active.id}
      id={BODY_ID}
      role="tabpanel"
      aria-labelledby={tabDomId(active.id)}
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      // Long surface lists virtualize against this scroll box (components/pr/VirtualStack).
      data-scroll-root
      data-testid="panel-body"
      data-surface={active.kind}
      data-tab-id={active.id}
    >
      {spec ? spec.render(active) : null}
    </div>
  );
}

/** The active tab's surface handles a chord (SurfaceSpec.onKey); true if it did. */
function surfaceKey(panelKey: string, chord: string): boolean {
  const e = getPanel(panelKey);
  const tab = e.tabs.find((t) => t.id === e.activeTabId);
  return tab ? (surfaceOf(tab.kind)?.onKey?.(chord, tab) ?? false) : false;
}

/**
 * The panel's header: tabs on the left, the expand button and the toggle at the far
 * right. 44px (h-11) like
 * every content pane header (window/PaneHeader), so it ends on the title band's bottom
 * edge beside them (window/titleBand.ts). Like them it drags the window: the empty
 * space around the tabs does, each tab and both buttons are `no-drag`.
 */
function PanelHeader({ panelKey, hasTabs }: { panelKey: string; hasTabs: boolean }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-pane-border pr-2 pl-1.5 [--wails-draggable:drag]" data-testid="panel-header">
      {hasTabs ? <TabStrip panelKey={panelKey} /> : <div className="min-w-0 flex-1" />}
      <span className="flex shrink-0 items-center gap-0.5">
        <PanelExpand />
        <PanelToggle inPanel />
      </span>
    </div>
  );
}

function Panel({ panelKey, max, expanded, asideRef }: { panelKey: string; max: number; expanded: boolean; asideRef: RefObject<HTMLElement | null> }) {
  // This panel's own width, bounded by the room there is now (the stored one comes back
  // when the room does). Expanded, it takes the whole row instead and keeps the width
  // for when the split comes back.
  const width = Math.min(usePanelWidth(panelKey), max);
  const hasTabs = usePanelStore((s) => (s.byKey[panelKey]?.tabs.length ?? 0) > 0);

  // Surfaces keep what their availability reads loaded while this panel shows.
  useEffect(() => {
    const ctx = surfaceContext(panelKey);
    const releases = surfaces.map((s) => s.warm?.(ctx));
    return () => {
      for (const release of releases) release?.();
    };
  }, [panelKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const chord = chordFromEvent(e.nativeEvent);
    if (!chord) return;
    // cmd+w applies in text fields too (it is no editing chord); letters do not.
    if (chord !== "cmd+w" && isEditable(e.target)) return;
    // The panel's own keys (cmd+w, the surface letters) are never offered to a surface.
    if (!isPanelChord(chord) && surfaceKey(panelKey, chord)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const action = panelKeyAction(chord, getPanel(panelKey), surfaceContext(panelKey));
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action.kind === "close") closeTab(panelKey, action.tabId);
    else if (action.kind === "hide") hidePanel(panelKey);
    else openSurface(panelKey, action.tab);
  };

  return (
    // The wrapper is not clipped so the resize handle can sit in the gap to its left.
    // Expanded, the content pane is hidden: the wrapper fills the row with the content
    // pane's own 8px margins, and there is nothing to resize against.
    <div
      className={cn("relative flex", expanded ? "m-2 min-w-0 flex-1" : "mt-2 mr-2 mb-2 shrink-0")}
      style={expanded ? undefined : { width }}
      data-testid="side-panel-wrapper"
      data-expanded={expanded || undefined}
    >
      {!expanded && <PanelResizeHandle panelKey={panelKey} width={width} max={max} />}
      <aside
        ref={asideRef}
        tabIndex={-1}
        aria-label="Side panel"
        data-region="panel"
        data-testid="side-panel"
        data-panel-key={panelKey}
        className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-pane-border bg-pane shadow-xs outline-none"
        onKeyDown={onKeyDown}
      >
        <PanelHeader panelKey={panelKey} hasTabs={hasTabs} />
        <Body panelKey={panelKey} />
      </aside>
    </div>
  );
}

/**
 * The current selection's side panel, right of the content pane. Unmounted (with its
 * resize handle) when the selection has none open, while the settings page is up, and
 * while the window has no room for it beside the content pane (panelMax < PANEL_MIN; it
 * stays open and comes back when there is room). An expanded panel always shows: it
 * replaces the content pane (App.tsx hides it) instead of sharing the row.
 *
 * Focus requests (ui panelFocusSeq) are handled here, not in the panel: this component
 * stays mounted, so a request with no panel showing is dropped instead of being acted on
 * by the next panel that mounts (e.g. after a selection switch). The request comes after
 * the panel is shown (stores/panel.ts update), so its aside is mounted by then.
 */
export function SidePanel() {
  const panelKey = useCurrentPanelKey();
  const open = usePanelStore((s) => (panelKey === null ? false : (s.byKey[panelKey]?.open ?? false)));
  const expanded = usePanelExpanded();
  const settingsOpen = useViewsStore((s) => s.settingsOpen);
  const max = useUiStore((s) => panelMax(s.windowWidth, visibleSidebarWidth(s)));
  const focusSeq = useUiStore((s) => s.panelFocusSeq);
  const asideRef = useRef<HTMLElement>(null);
  const handled = useRef(focusSeq);

  useEffect(() => {
    if (focusSeq === handled.current) return;
    handled.current = focusSeq;
    asideRef.current?.focus({ preventScroll: true });
  }, [focusSeq]);

  if (panelKey === null || !open || settingsOpen || (max < PANEL_MIN && !expanded)) return null;
  return <Panel key={panelKey} panelKey={panelKey} max={max} expanded={expanded} asideRef={asideRef} />;
}
