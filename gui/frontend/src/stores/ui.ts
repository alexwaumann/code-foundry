import { create } from "zustand";
import { persist } from "zustand/middleware";

/** What the content area shows. Derived into the UiContext sent with List/Invoke. */
export type Selection =
  | { kind: "none" }
  | { kind: "terminal"; id: string }
  | { kind: "session"; id: string }
  | { kind: "repo"; repoId: string }
  | { kind: "worktree"; repoId: string; path: string }
  /**
   * The new-thread composer (picked in the project picker): for a project, or with
   * workspaceId for a workspace, repoId then being a member's (for the command context).
   */
  | { kind: "compose"; repoId: string; workspaceId?: string }
  /** A top-level page that is not a sidebar row (see components/prs). */
  | { kind: "view"; name: string };

/** Top-level page names (UiIntent.ShowView); unknown names are ignored. */
export const viewNames: readonly string[] = ["pullrequests", "projects"];

/** Which region has keyboard focus; the palette returns focus to it on close. */
export type FocusRegion = "sidebar" | "terminal" | "content" | "palette" | "panel";

/**
 * What the palette dialog shows: the command list (and arg prompts), the project picker,
 * or the member picker of "Run in…" (for `palette.sessionId`).
 */
export type PalettePage = "commands" | "projects" | "runin";

/**
 * The sidebar band must fit the 80px traffic-light gutter, the app name, the attention
 * badge and the New thread button (components/sidebar/Sidebar.tsx); 180 squeezed the name out.
 */
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 520;
/** The initial width, and what double-clicking the resize handle restores. */
export const SIDEBAR_DEFAULT = 280;
/** Side panel width bounds; the upper bound depends on the window and sidebar (panelMax). */
export const PANEL_MIN = 280;
export const PANEL_MAX_FRACTION = 0.6;
export const PANEL_DEFAULT = 420;
/** The content pane never gets narrower than this to make room for the side panel. */
export const CONTENT_MIN = 360;
/**
 * Horizontal gaps around the panes when the side panel shows: the content pane's 8px
 * margins on both sides plus the panel's 8px right margin (App.tsx, SidePanel.tsx).
 */
export const PANE_GAPS = 24;
export const FONT_MIN = 9;
export const FONT_MAX = 28;
export const FONT_DEFAULT = 13;
/**
 * Page zoom steps in percent (cmd+= / cmd+-), the browser ladder from 90%. The zoom scales the
 * whole window: CSS `zoom` on <html> (lib/zoom.ts), and the terminal font with it.
 */
export const ZOOM_LEVELS: readonly number[] = [90, 100, 110, 125, 150, 175, 200];
export const ZOOM_DEFAULT = 100;
export const ZOOM_MIN = ZOOM_LEVELS[0] ?? 90;
export const ZOOM_MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? 200;

/** The ladder step after `zoom` in the given direction; the end of the ladder repeats. */
export function nextZoom(zoom: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_LEVELS.find((z) => z > zoom) ?? ZOOM_MAX;
  for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
    const z = ZOOM_LEVELS[i];
    if (z !== undefined && z < zoom) return z;
  }
  return ZOOM_MIN;
}

interface UiState {
  selection: Selection;
  focus: FocusRegion;
  /** Incremented to ask the terminal pane to take focus. */
  terminalFocusSeq: number;
  /** Incremented to ask the sidebar list to take focus. */
  sidebarFocusSeq: number;
  /** Incremented to ask the visible side panel to take focus (components/panel/SidePanel.tsx). */
  panelFocusSeq: number;
  /**
   * Incremented to ask whatever fills the content pane to take focus: the terminal when
   * one shows, else the page's `[data-focus-root]` element (App.tsx).
   */
  contentFocusSeq: number;
  /** window.innerWidth, kept current by startApp; bounds the side panel (panelMax). */
  windowWidth: number;
  /** Row key the sidebar keyboard cursor is on. */
  cursorKey: string | null;
  palette: { open: boolean; query: string; commandName: string | null; page: PalettePage; returnTo: FocusRegion; sessionId?: string };
  /** Incremented to ask the composer to take focus. */
  composerFocusSeq: number;
  /** Session whose sidebar row is in inline-rename mode. */
  renamingSessionId: string | null;

  // Persisted settings.
  sidebarVisible: boolean;
  sidebarWidth: number;
  /** Terminal font size in px before zoom (appearance.font_size). */
  fontSize: number;
  /** Page zoom in percent (appearance.zoom). */
  zoom: number;

  select: (sel: Selection, opts?: { focusTerminal?: boolean }) => void;
  setFocus: (f: FocusRegion) => void;
  focusSidebar: () => void;
  setCursor: (key: string | null) => void;
  openPalette: (query?: string, commandName?: string | null) => void;
  /** Opens the palette on the project picker (session.new's presenter). */
  openProjectPicker: (returnTo?: FocusRegion) => void;
  /** Opens the palette on the "Run in…" member picker for a thread (session.run-in's presenter). */
  openRunInPicker: (sessionId: string, returnTo?: FocusRegion) => void;
  closePalette: () => void;
  focusComposer: () => void;
  setRenaming: (sessionId: string | null) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  /**
   * Records a window resize. Stored panel widths (stores/panel.ts, one per panel) are not
   * re-clamped: the panel renders at min(stored, panelMax).
   */
  setWindowWidth: (w: number) => void;
  focusContent: () => void;
  setFontSize: (n: number) => void;
  setZoom: (percent: number) => void;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Widest the side panel may be: 60% of the window, and no more than leaves CONTENT_MIN
 * for the content pane beside a sidebar this wide (0 when hidden). Below PANEL_MIN means
 * the panel does not fit; SidePanel then hides it (it stays open in the panel store).
 */
export function panelMax(windowWidth: number, sidebarWidth: number): number {
  return Math.floor(Math.min(windowWidth * PANEL_MAX_FRACTION, windowWidth - sidebarWidth - PANE_GAPS - CONTENT_MIN));
}

/** The sidebar's rendered width: 0 when hidden. */
export function visibleSidebarWidth(s: { sidebarVisible: boolean; sidebarWidth: number }): number {
  return s.sidebarVisible ? s.sidebarWidth : 0;
}

/** A panel width clamped to [PANEL_MIN, panelMax] (PANEL_MIN when the panel does not fit). */
export function clampPanelWidth(w: number, windowWidth: number, sidebarWidth: number): number {
  return clamp(Math.round(w), PANEL_MIN, Math.max(PANEL_MIN, panelMax(windowWidth, sidebarWidth)));
}

export function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "none":
      return true;
    case "terminal":
    case "session":
      return a.id === (b as typeof a).id;
    case "repo":
      return a.repoId === (b as typeof a).repoId;
    case "compose":
      return a.repoId === (b as typeof a).repoId && a.workspaceId === (b as typeof a).workspaceId;
    case "worktree":
      return a.repoId === (b as typeof a).repoId && a.path === (b as typeof a).path;
    case "view":
      return a.name === (b as typeof a).name;
  }
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      selection: { kind: "none" },
      focus: "content",
      terminalFocusSeq: 0,
      sidebarFocusSeq: 0,
      panelFocusSeq: 0,
      contentFocusSeq: 0,
      windowWidth: typeof window === "undefined" ? 1280 : window.innerWidth,
      cursorKey: null,
      palette: { open: false, query: "", commandName: null, page: "commands", returnTo: "content" },
      composerFocusSeq: 0,
      renamingSessionId: null,
      sidebarVisible: true,
      sidebarWidth: SIDEBAR_DEFAULT,
      fontSize: FONT_DEFAULT,
      zoom: ZOOM_DEFAULT,

      select: (sel, opts) => {
        set((s) => ({
          selection: sameSelection(s.selection, sel) ? s.selection : sel,
          terminalFocusSeq:
            opts?.focusTerminal && (sel.kind === "terminal" || sel.kind === "session") ? s.terminalFocusSeq + 1 : s.terminalFocusSeq,
        }));
      },
      setRenaming: (renamingSessionId) => {
        set({ renamingSessionId });
      },
      setFocus: (focus) => {
        set({ focus });
      },
      focusSidebar: () => {
        set((s) => ({ sidebarVisible: true, sidebarFocusSeq: s.sidebarFocusSeq + 1 }));
      },
      setCursor: (cursorKey) => {
        set({ cursorKey });
      },
      openPalette: (query = "", commandName = null) => {
        set((s) => ({ palette: { open: true, query, commandName, page: "commands", returnTo: s.palette.open ? s.palette.returnTo : s.focus } }));
      },
      openProjectPicker: (returnTo) => {
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "projects", returnTo: returnTo ?? (s.palette.open ? s.palette.returnTo : s.focus) } }));
      },
      openRunInPicker: (sessionId, returnTo) => {
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "runin", sessionId, returnTo: returnTo ?? (s.palette.open ? s.palette.returnTo : s.focus) } }));
      },
      focusComposer: () => {
        set((s) => ({ composerFocusSeq: s.composerFocusSeq + 1 }));
      },
      closePalette: () => {
        // Hand focus back to where it was before the palette opened. A command run from
        // the palette may move that target first (togglePanelCommand in stores/views.ts).
        set((s) => {
          const to = s.palette.returnTo;
          return {
            palette: { open: false, query: "", commandName: null, page: "commands", returnTo: "content" },
            terminalFocusSeq: to === "terminal" ? s.terminalFocusSeq + 1 : s.terminalFocusSeq,
            sidebarFocusSeq: to === "sidebar" ? s.sidebarFocusSeq + 1 : s.sidebarFocusSeq,
            panelFocusSeq: to === "panel" ? s.panelFocusSeq + 1 : s.panelFocusSeq,
            contentFocusSeq: to === "content" ? s.contentFocusSeq + 1 : s.contentFocusSeq,
          };
        });
      },
      toggleSidebar: () => {
        set((s) => ({ sidebarVisible: !s.sidebarVisible }));
      },
      setSidebarWidth: (w) => {
        set({ sidebarWidth: clamp(Math.round(w), SIDEBAR_MIN, SIDEBAR_MAX) });
      },
      setWindowWidth: (windowWidth) => {
        set({ windowWidth });
      },
      focusContent: () => {
        set((s) => ({ contentFocusSeq: s.contentFocusSeq + 1 }));
      },
      setFontSize: (n) => {
        set({ fontSize: clamp(Math.round(n), FONT_MIN, FONT_MAX) });
      },
      setZoom: (percent) => {
        set({ zoom: clamp(Math.round(percent), ZOOM_MIN, ZOOM_MAX) });
      },
    }),
    {
      name: "code-foundry.ui",
      // 2: the global panelWidth moved to per-panel widths in the panel store; drop it.
      // 3: the sidebar is a flat thread list (no collapsible repos or worktrees); drop collapsed.
      version: 3,
      migrate: (persisted) => {
        const { panelWidth: _old, collapsed: _gone, ...rest } = (persisted ?? {}) as Record<string, unknown>;
        return rest as Partial<UiState> as UiState;
      },
      // A saved width outside [SIDEBAR_MIN, SIDEBAR_MAX] (e.g. 180, saved before the minimum
      // rose to 220) is clamped on load, so it renders and drags from a valid width.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UiState>;
        const merged = { ...current, ...p };
        return typeof p.sidebarWidth === "number" ? { ...merged, sidebarWidth: clamp(Math.round(p.sidebarWidth), SIDEBAR_MIN, SIDEBAR_MAX) } : merged;
      },
      partialize: (s) => ({
        sidebarVisible: s.sidebarVisible,
        sidebarWidth: s.sidebarWidth,
        fontSize: s.fontSize,
        zoom: s.zoom,
      }),
    },
  ),
);
