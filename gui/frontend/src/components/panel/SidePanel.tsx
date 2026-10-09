import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { chordFromEvent } from "@/keys/chord";
import { cn } from "@/lib/utils";
import { activatePanelTab, closePanelTab, emptyEntry, getPanel, openSurface, useCurrentPanelKey, usePanelStore, type Tab } from "@/stores/panel";
import { useUiStore } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { listedSurfaces, surfaceOf, type SurfaceContext } from "@/surfaces/registry";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { panelKeyAction } from "./keys";

/** Last panel focus request (usePanelStore focusSeq) a mounted panel acted on. */
let handledFocusSeq = 0;

function isEditable(el: EventTarget): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);
}

function surfaceContext(panelKey: string): SurfaceContext {
  return { selection: useUiStore.getState().selection, panelKey };
}

/** Closing the panel's last tab hides it; hand focus back to the content terminal. */
function closeTab(panelKey: string, id: string): void {
  closePanelTab(panelKey, id);
  if (!getPanel(panelKey).open) useUiStore.setState((s) => ({ terminalFocusSeq: s.terminalFocusSeq + 1 }));
}

function TabButton({ panelKey, tab, active }: { panelKey: string; tab: Tab; active: boolean }) {
  const Icon = surfaceOf(tab.kind)?.icon;
  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      className={cn(
        "group flex h-7 max-w-48 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 text-xs",
        active ? "bg-accent text-accent-foreground dark:bg-accent/50" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // middle click closes, below
      }}
      onClick={() => {
        activatePanelTab(panelKey, tab.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) closeTab(panelKey, tab.id);
      }}
    >
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
      <span className="truncate">{tab.title}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Close ${tab.title}`}
        title="Close tab"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-foreground/10",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        onClick={(e) => {
          e.stopPropagation();
          closeTab(panelKey, tab.id);
        }}
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}

function TabStrip({ panelKey }: { panelKey: string }) {
  const tabs = usePanelStore((s) => s.byKey[panelKey]?.tabs ?? emptyEntry.tabs);
  const activeTabId = usePanelStore((s) => s.byKey[panelKey]?.activeTabId ?? null);
  return (
    <div
      role="tablist"
      aria-label="Side panel tabs"
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-pane-border px-1.5 [scrollbar-width:none]"
      data-testid="panel-tabs"
    >
      {tabs.map((t) => (
        <TabButton key={t.id} panelKey={panelKey} tab={t} active={t.id === activeTabId} />
      ))}
    </div>
  );
}

/** No tabs yet: the surfaces this selection can open, with their hotkeys (as in T3 Code). */
function EmptyState({ panelKey }: { panelKey: string }) {
  const selection = useUiStore((s) => s.selection);
  const items = useMemo(() => listedSurfaces({ selection, panelKey }), [selection, panelKey]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6" data-testid="panel-empty">
      <div className="w-full max-w-64">
        <h2 className="mb-3 text-center text-sm font-medium">Open a surface</h2>
        <ul className="flex flex-col gap-0.5">
          {items.map(({ spec, availability }) => {
            const enabled = availability === "enabled";
            return (
              <li key={spec.kind}>
                <button
                  type="button"
                  disabled={!enabled}
                  data-surface={spec.kind}
                  data-availability={availability}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm enabled:hover:bg-accent disabled:cursor-default disabled:opacity-45"
                  onClick={() => {
                    const ctx = surfaceContext(panelKey);
                    const tab = spec.openDefault(ctx);
                    if (tab && spec.available(ctx) === "enabled") openSurface(panelKey, tab);
                  }}
                >
                  <spec.icon className="size-4 text-muted-foreground" aria-hidden />
                  <span className="flex-1 truncate">{spec.title}</span>
                  <kbd className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground">{spec.hotkey.toUpperCase()}</kbd>
                </button>
              </li>
            );
          })}
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
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="panel-body" data-surface={active.kind}>
      {spec ? spec.render(active) : null}
    </div>
  );
}

function Panel({ panelKey }: { panelKey: string }) {
  const width = useUiStore((s) => s.panelWidth);
  const focusSeq = usePanelStore((s) => s.focusSeq);
  const hasTabs = usePanelStore((s) => (s.byKey[panelKey]?.tabs.length ?? 0) > 0);
  const ref = useRef<HTMLElement>(null);

  // Toggling the panel on asks it to take focus, so its hotkeys and cmd+w work at once.
  // The panel mounts on that same toggle, so the handled request is tracked outside the
  // component; a remount from a selection switch finds nothing new and leaves focus be.
  useEffect(() => {
    if (focusSeq !== handledFocusSeq) {
      handledFocusSeq = focusSeq;
      ref.current?.focus({ preventScroll: true });
    }
  }, [focusSeq]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (isEditable(e.target)) return;
    const chord = chordFromEvent(e.nativeEvent);
    if (!chord) return;
    const action = panelKeyAction(chord, getPanel(panelKey), surfaceContext(panelKey));
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action.kind === "close") closeTab(panelKey, action.tabId);
    else openSurface(panelKey, action.tab);
  };

  return (
    // The wrapper is not clipped so the resize handle can sit in the gap to its left.
    <div className="relative mr-2 mb-2 flex shrink-0" style={{ width, minWidth: 280, maxWidth: "60vw" }}>
      <PanelResizeHandle />
      <aside
        ref={ref}
        tabIndex={-1}
        aria-label="Side panel"
        data-region="panel"
        data-testid="side-panel"
        data-panel-key={panelKey}
        className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-pane-border bg-pane shadow-xs outline-none"
        onKeyDown={onKeyDown}
      >
        {hasTabs && <TabStrip panelKey={panelKey} />}
        <Body panelKey={panelKey} />
      </aside>
    </div>
  );
}

/**
 * The current selection's side panel, right of the content pane. Unmounted (with its
 * resize handle) when the selection has none open, and while the settings page is up.
 */
export function SidePanel() {
  const panelKey = useCurrentPanelKey();
  const open = usePanelStore((s) => (panelKey === null ? false : (s.byKey[panelKey]?.open ?? false)));
  const settingsOpen = useViewsStore((s) => s.settingsOpen);
  if (panelKey === null || !open || settingsOpen) return null;
  return <Panel key={panelKey} panelKey={panelKey} />;
}
