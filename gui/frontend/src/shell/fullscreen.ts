/**
 * Full screen (docs/notes/shell-model.md, "Full screen"): one pane over the whole pane area, the
 * top bar and the sidebar staying. Window state (stores/shellView.ts `fullscreen`), never stored
 * in the layout. pane.fullscreen is the command; cmd+shift+enter (its keybinding), the strip's
 * button and a rail's run it here, Escape or the same key leave.
 *
 * The pane shown is always the space's focused pane: pane focus and move keys do nothing while it
 * is on, so the focus moves only when the user asks for something elsewhere (a sidebar click on a
 * thread in another pane, back and forward, a linked surface placed in another pane), and full
 * screen then shows that pane. It ends when the window leaves the space or the space has no pane.
 * See docs/notes/shell-19-rails-fullscreen.md.
 */
import { useDictationStore } from "@/stores/dictation";
import { useLayoutStore, type LayoutState, type TabEntry } from "@/stores/layout";
import { requestPaneFocus, setFullscreen, useShellViewStore } from "@/stores/shellView";
import { focusPaneNow } from "./commands";

type Layout = Pick<LayoutState, "currentSpaceId" | "spaces" | "panes">;

/** The pane shown full screen: the focused pane of the space full screen is on in, while it is the current one; "" otherwise. */
export function fullscreenPaneOf(s: Layout, fullscreen: string): string {
  if (!fullscreen || fullscreen !== s.currentSpaceId) return "";
  const focus = s.spaces[fullscreen]?.focus ?? "";
  return focus && s.panes[focus] ? focus : "";
}

/** The pane shown full screen now; "" when full screen is off. */
export function useFullscreenPane(): string {
  const fullscreen = useShellViewStore((v) => v.fullscreen);
  return useLayoutStore((s) => fullscreenPaneOf(s, fullscreen));
}

/** Whether full screen is on now (pane focus and move keys do nothing then). */
export function fullscreenOn(): boolean {
  return fullscreenPaneOf(useLayoutStore.getState(), useShellViewStore.getState().fullscreen) !== "";
}

/** Shows `paneId` (default: the focused pane) full screen: it takes the focus first. */
export function enterFullscreen(paneId?: string): void {
  const s = useLayoutStore.getState();
  const space = s.spaces[s.currentSpaceId];
  const pane = paneId || space?.focus || "";
  if (!space || !s.panes[pane] || s.panes[pane].spaceId !== space.id) return;
  if (space.focus !== pane) {
    void focusPaneNow(pane);
    requestPaneFocus(pane);
  }
  setFullscreen(space.id);
}

export function leaveFullscreen(): void {
  if (useShellViewStore.getState().fullscreen) setFullscreen("");
}

/** On for `paneId` (default: the focused pane), or off when it is on. */
export function toggleFullscreen(paneId?: string): void {
  if (fullscreenOn()) leaveFullscreen();
  else enterFullscreen(paneId);
}

/** pane.fullscreen's presentation: `mode` on, off or toggle (the default), `pane` the pane to show. */
export function presentFullscreen(params?: Readonly<Record<string, string>>): boolean {
  const pane = params?.pane ?? "";
  switch (params?.mode) {
    case "on":
      enterFullscreen(pane);
      break;
    case "off":
      leaveFullscreen();
      break;
    default: {
      // A toggle naming another pane than the one shown moves full screen there.
      const s = useLayoutStore.getState();
      if (pane && fullscreenOn() && s.spaces[s.currentSpaceId]?.focus !== pane) enterFullscreen(pane);
      else toggleFullscreen(pane);
    }
  }
  return true;
}

/**
 * Whether a bare Escape that reached the window leaves full screen: nothing took it before (a
 * menu, a dialog, a popover, the composer's own cards prevent it or keep it inside), it was not
 * typed into a terminal (a shell's own Escape), a dialog or a menu, and it has no modifier. A list
 * on the page (a diff's file list) does not keep it; a list in a popover that the key closed is
 * gone from the document by now.
 */
export function escapeLeaves(e: Pick<KeyboardEvent, "key" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "target">): boolean {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  const t = e.target instanceof Element ? e.target : null;
  // Something under the key went away with it (a popover closed by its own Escape).
  if (t && !t.isConnected) return false;
  return !t?.closest('[data-terminal-host], [role="dialog"], [role="alertdialog"], [role="menu"], [data-keys-local]');
}

/**
 * Whether a bare Escape typed in a prompt leaves full screen, decided before the prompt sees it
 * (Shell's capture listener). The prompt's editor marks every Escape handled (ProseMirror's own
 * key handling does for Escape and Enter), so the bubbling listener never sees one from there:
 * focus in a prompt, full screen would not end. The prompt keeps it while it has a use for it: a
 * completion or history card open (the editor names it: aria-controls), dictation running (Escape
 * stops it), or the floating composer's prompt (Escape collapses it). An empty composer's Escape
 * back to its project's page waits until full screen is off. See
 * docs/notes/shell-25b-audits.md.
 */
export function promptEscapeLeaves(e: Pick<KeyboardEvent, "key" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "target">): boolean {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  const t = e.target instanceof Element ? e.target : null;
  const prompt = t?.closest<HTMLElement>('[data-testid="composer-input"]');
  if (!prompt || prompt.hasAttribute("aria-controls") || prompt.closest('[data-testid="floating-composer"]')) return false;
  return useDictationStore.getState().active === null;
}

/** The thread whose composer floats over a full-screened tab: a linked surface's thread; "" for others. */
export function floatingThreadOf(tab: Pick<TabEntry, "kind" | "thread"> | undefined): string {
  if (!tab || tab.kind === "thread" || tab.kind === "compose") return "";
  return tab.thread;
}

/** Margin kept between the floating composer and the pane's edges, in layout px. */
export const FLOAT_MARGIN = 12;

/**
 * The floating composer's drag, held so the card stays inside the pane: `spot` is where it opens
 * (its box with no drag), `area` the pane's size. Both in layout px.
 */
export function clampFloat(drag: { x: number; y: number }, spot: { x: number; y: number; w: number; h: number }, area: { w: number; h: number }): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return {
    x: clamp(drag.x, FLOAT_MARGIN - spot.x, area.w - FLOAT_MARGIN - (spot.x + spot.w)),
    y: clamp(drag.y, FLOAT_MARGIN - spot.y, area.h - FLOAT_MARGIN - (spot.y + spot.h)),
  };
}
