import { useEffect, useMemo, useRef } from "react";
import { ErrorBoundary } from "@/components/error/ErrorBoundary";
import { PaneError } from "@/components/error/fallbacks";
import { trafficLightGutter } from "@/components/window/titleBand";
import { lastInputWasKeyboard } from "@/lib/inputModality";
import { cn } from "@/lib/utils";
import { focusPaneNow } from "@/shell/commands";
import type { PaneRect } from "@/shell/geometry/types";
import { usePaneDragged } from "@/shell/drag/state";
import { ShellPaneContext, type ShellPane } from "@/shell/paneContext";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { useLayoutStore, usePane, useTab, type TabEntry } from "@/stores/layout";
import { useShellViewStore } from "@/stores/shellView";
import { useUiStore } from "@/stores/ui";
import { shellBodyDomId, shellTabDomId } from "@/shell/domIds";
import { PaneTabStrip } from "./PaneTabStrip";

/** The active tab's body, under key={tab.id}: a tab that is not active mounts nothing (and holds no stream). */
function SurfaceBody({ tab }: { tab: TabEntry }) {
  return <>{shellSurfaceOf(tab.kind).render(tab)}</>;
}

/**
 * Moves the keyboard into a pane's active tab: a thread's prompt (ui promptFocusSeq, which only
 * the focused pane's thread serves: shell/paneContext.ts), the composer's prompt, else the page's
 * focus root, else the body itself.
 */
function focusInto(body: HTMLElement, kind: string): void {
  if (kind === "thread") {
    useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
    return;
  }
  if (kind === "compose") {
    useUiStore.getState().focusComposer();
    return;
  }
  const root = body.querySelector<HTMLElement>("[data-focus-root]") ?? body;
  root.focus({ preventScroll: true });
}

/**
 * One pane of the grid at its drawn rectangle: its tab strip, then its active tab's body. A
 * pointer press or the keyboard (Tab) entering it focuses it (pane.focus, shown at once); a focus
 * request (a direction key, a closed tab) moves the keyboard into its active tab.
 */
export function PaneView({ paneId, rect, focused }: { paneId: string; rect: PaneRect; focused: boolean }) {
  const pane = usePane(paneId);
  const tab = useTab(pane?.active ?? "");
  const bodyRef = useRef<HTMLDivElement>(null);
  // With the sidebar hidden, the pane in the window's top left corner sits under the traffic lights.
  const inset = useUiStore((s) => (!s.sidebarVisible && rect.x === 0 && rect.y === 0 ? trafficLightGutter(s.zoom) - 6 : 0));
  const request = useShellViewStore((s) => (s.focusRequest.paneId === paneId ? s.focusRequest.seq : 0));
  const kind = tab?.kind ?? "";
  const dragged = usePaneDragged(paneId);
  useEffect(() => {
    if (request === 0 || !bodyRef.current) return;
    focusInto(bodyRef.current, kind);
    // Only a new request moves the keyboard; a tab switching under it does not.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [request]);
  const ctx = useMemo<ShellPane>(() => ({ paneId, focused }), [paneId, focused]);
  const takeFocus = () => {
    // Read now: a press right after a key may beat the render.
    const s = useLayoutStore.getState();
    const space = s.spaces[s.panes[paneId]?.spaceId ?? ""];
    if (space?.focus !== paneId) void focusPaneNow(paneId);
  };
  return (
    <section
      className={cn("absolute flex flex-col overflow-hidden rounded-pane border border-cf-divider bg-cf-surface shadow-xs", dragged && "opacity-60")}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      aria-label={tab ? undefined : "Pane"}
      aria-labelledby={tab ? shellTabDomId(tab.id) : undefined}
      data-testid="shell-pane"
      data-pane-id={paneId}
      data-focused={focused || undefined}
      data-dragging={dragged || undefined}
      onPointerDownCapture={takeFocus}
      // The keyboard entering the pane (Tab) focuses it; a surface focusing itself as it mounts does not.
      onFocusCapture={() => {
        if (lastInputWasKeyboard()) takeFocus();
      }}
    >
      <PaneTabStrip paneId={paneId} focused={focused} inset={inset} />
      <div ref={bodyRef} id={shellBodyDomId(paneId)} role="tabpanel" tabIndex={-1} className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none" data-testid="shell-pane-body">
        {tab && (
          <ShellPaneContext.Provider value={ctx}>
            <ErrorBoundary key={tab.id} label={`${tab.kind} tab`} fallback={PaneError}>
              <SurfaceBody tab={tab} />
            </ErrorBoundary>
          </ShellPaneContext.Provider>
        )}
      </div>
    </section>
  );
}
