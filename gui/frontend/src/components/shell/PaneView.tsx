import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { chordFromEvent } from "@/keys/chord";
import { keyTarget } from "@/lib/keyTarget";
import { ErrorBoundary } from "@/components/error/ErrorBoundary";
import { PaneError } from "@/components/error/fallbacks";
import { lastInputWasKeyboard } from "@/lib/inputModality";
import { cn } from "@/lib/utils";
import { focusPaneNow } from "@/shell/commands";
import type { PaneRect } from "@/shell/geometry/types";
import { usePaneDragged } from "@/shell/drag/state";
import { ShellPaneContext, type ShellPane } from "@/shell/paneContext";
import { focusPaneBody } from "@/shell/paneBox";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { useLayoutStore, usePane, useTab, type TabEntry } from "@/stores/layout";
import { useShellViewStore } from "@/stores/shellView";
import { floatingThreadOf, useFullscreenPane } from "@/shell/fullscreen";
import { useUiStore } from "@/stores/ui";
import { shellBodyDomId, shellTabDomId } from "@/shell/domIds";
import { LinkedRow } from "./LinkedRow";
import { PaneTabStrip } from "./PaneTabStrip";
import { PaneRail } from "./PaneRail";
import { FloatingComposer } from "./FloatingComposer";

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
  focusPaneBody(body);
}

function isEditable(el: Element | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);
}

/**
 * A key pressed inside the pane, outside text fields, that the window's keymap left alone: its
 * active tab's surface may take it (SurfaceSpec.onKey: a pull request's cmd+shift+c), as the side
 * panel offered its keys. Portalled popups' keys bubble here through React too.
 */
function surfaceKey(e: KeyboardEvent<HTMLElement>, tab: TabEntry | undefined): void {
  if (!tab || e.defaultPrevented) return;
  const onKey = shellSurfaceOf(tab.kind).onKey;
  const chord = onKey ? chordFromEvent(e.nativeEvent) : null;
  if (!onKey || !chord || isEditable(keyTarget(e.nativeEvent))) return;
  if (!onKey(chord, tab)) return;
  e.preventDefault();
  e.stopPropagation();
}

/**
 * One pane of the grid at its drawn rectangle: folded to a rail (PaneRail: no body, no stream), or
 * open (OpenPane). Switching between the two unmounts the other.
 */
export function PaneView({ paneId, rect, focused }: { paneId: string; rect: PaneRect; focused: boolean }) {
  return rect.rail ? <PaneRail paneId={paneId} rect={rect} focused={focused} /> : <OpenPane paneId={paneId} rect={rect} focused={focused} />;
}

/**
 * An open pane: its tab strip, then its active tab's body. A pointer press or the keyboard (Tab)
 * entering it focuses it (pane.focus, shown at once); a focus request (a direction key, a closed
 * tab, a click on a rail's icon) moves the keyboard into its active tab. A key inside it may be
 * its active surface's own (surfaceKey). Full screen, a linked tab's thread composer floats over
 * the body (FloatingComposer).
 */
function OpenPane({ paneId, rect, focused }: { paneId: string; rect: PaneRect; focused: boolean }) {
  const pane = usePane(paneId);
  const tab = useTab(pane?.active ?? "");
  const bodyRef = useRef<HTMLDivElement>(null);
  const request = useShellViewStore((s) => (s.focusRequest.paneId === paneId ? s.focusRequest.seq : 0));
  const kind = tab?.kind ?? "";
  const dragged = usePaneDragged(paneId);
  const full = useFullscreenPane() === paneId;
  const floating = full ? floatingThreadOf(tab) : "";
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
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-pane border bg-cf-surface shadow-xs",
        // The focused pane's border takes a tint of the accent (docs/notes/shell-model.md, "Structure").
        focused ? "border-cf-accent/60" : "border-cf-divider",
        dragged && "opacity-60",
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      aria-label={tab ? undefined : "Pane"}
      aria-labelledby={tab ? shellTabDomId(tab.id) : undefined}
      data-testid="shell-pane"
      data-pane-id={paneId}
      data-focused={focused || undefined}
      data-fullscreen={full || undefined}
      data-dragging={dragged || undefined}
      // Popups keep inside it, and a surface part that closes hands it the keyboard (shell/paneBox.ts).
      data-pane-box
      onPointerDownCapture={takeFocus}
      onKeyDown={(e) => {
        surfaceKey(e, tab);
      }}
      // The keyboard entering the pane (Tab) focuses it; a surface focusing itself as it mounts does not.
      onFocusCapture={() => {
        if (lastInputWasKeyboard()) takeFocus();
      }}
    >
      <PaneTabStrip paneId={paneId} focused={focused} fullscreen={full} />
      {tab && <LinkedRow tab={tab} />}
      <div ref={bodyRef} id={shellBodyDomId(paneId)} role="tabpanel" className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none" data-testid="shell-pane-body">
        {tab && (
          <ShellPaneContext.Provider value={ctx}>
            <ErrorBoundary key={tab.id} label={`${tab.kind} tab`} fallback={PaneError}>
              <SurfaceBody tab={tab} />
            </ErrorBoundary>
          </ShellPaneContext.Provider>
        )}
      </div>
      {floating && <FloatingComposer key={floating} threadId={floating} paneId={paneId} />}
    </section>
  );
}
