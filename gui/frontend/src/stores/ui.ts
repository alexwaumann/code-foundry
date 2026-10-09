import { create } from "zustand";
import { persist } from "zustand/middleware";

/** What the content area shows. Derived into the UiContext sent with List/Invoke. */
export type Selection =
  | { kind: "none" }
  | { kind: "terminal"; id: string }
  | { kind: "session"; id: string }
  | { kind: "repo"; repoId: string }
  | { kind: "worktree"; repoId: string; path: string }
  /** The new-thread composer for a repo (picked in the project picker). */
  | { kind: "compose"; repoId: string }
  /** A top-level page that is not a sidebar row (see components/prs). */
  | { kind: "view"; name: string };

/** Top-level page names (UiIntent.ShowView); unknown names are ignored. */
export const viewNames: readonly string[] = ["pullrequests"];

/** Which region has keyboard focus; the palette returns focus to it on close. */
export type FocusRegion = "sidebar" | "terminal" | "content" | "palette" | "panel";

/** What the palette dialog shows: the command list (and arg prompts) or the project picker. */
export type PalettePage = "commands" | "projects";

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 520;
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
  collapsed: Readonly<Record<string, boolean>>;
  palette: { open: boolean; query: string; commandName: string | null; page: PalettePage; returnTo: FocusRegion };
  /** Incremented to ask the composer to take focus. */
  composerFocusSeq: number;
  /** Session whose sidebar row is in inline-rename mode. */
  renamingSessionId: string | null;

  // Persisted settings.
  sidebarVisible: boolean;
  sidebarWidth: number;
  /** Side panel width (one value for every selection's panel; see stores/panel.ts). */
  panelWidth: number;
  fontSize: number;

  select: (sel: Selection, opts?: { focusTerminal?: boolean }) => void;
  setFocus: (f: FocusRegion) => void;
  focusSidebar: () => void;
  setCursor: (key: string | null) => void;
  toggleCollapsed: (key: string, collapsed?: boolean) => void;
  openPalette: (query?: string, commandName?: string | null) => void;
  /** Opens the palette on the project picker (session.new's presenter). */
  openProjectPicker: (returnTo?: FocusRegion) => void;
  closePalette: () => void;
  focusComposer: () => void;
  setRenaming: (sessionId: string | null) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  /** Clamps to [PANEL_MIN, panelMax] for the current window and sidebar. */
  setPanelWidth: (w: number) => void;
  /** Records a window resize and re-clamps the stored panel width to the new room. */
  setWindowWidth: (w: number) => void;
  focusContent: () => void;
  setFontSize: (n: number) => void;
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

/** A stored panel width clamped to [PANEL_MIN, panelMax] (PANEL_MIN when the panel does not fit). */
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
    case "compose":
      return a.repoId === (b as typeof a).repoId;
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
      collapsed: {},
      palette: { open: false, query: "", commandName: null, page: "commands", returnTo: "content" },
      composerFocusSeq: 0,
      renamingSessionId: null,
      sidebarVisible: true,
      sidebarWidth: 260,
      panelWidth: PANEL_DEFAULT,
      fontSize: FONT_DEFAULT,

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
      toggleCollapsed: (key, collapsed) => {
        set((s) => {
          const next = collapsed ?? !s.collapsed[key];
          if (Boolean(s.collapsed[key]) === next) return s;
          const { [key]: _old, ...rest } = s.collapsed;
          return { collapsed: next ? { ...rest, [key]: true } : rest };
        });
      },
      openPalette: (query = "", commandName = null) => {
        set((s) => ({ palette: { open: true, query, commandName, page: "commands", returnTo: s.palette.open ? s.palette.returnTo : s.focus } }));
      },
      openProjectPicker: (returnTo) => {
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "projects", returnTo: returnTo ?? (s.palette.open ? s.palette.returnTo : s.focus) } }));
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
      setPanelWidth: (w) => {
        set((s) => ({ panelWidth: clampPanelWidth(w, s.windowWidth, visibleSidebarWidth(s)) }));
      },
      setWindowWidth: (windowWidth) => {
        set((s) => ({ windowWidth, panelWidth: clampPanelWidth(s.panelWidth, windowWidth, visibleSidebarWidth(s)) }));
      },
      focusContent: () => {
        set((s) => ({ contentFocusSeq: s.contentFocusSeq + 1 }));
      },
      setFontSize: (n) => {
        set({ fontSize: clamp(Math.round(n), FONT_MIN, FONT_MAX) });
      },
    }),
    {
      name: "code-foundry.ui",
      version: 1,
      partialize: (s) => ({
        sidebarVisible: s.sidebarVisible,
        sidebarWidth: s.sidebarWidth,
        panelWidth: s.panelWidth,
        fontSize: s.fontSize,
        collapsed: s.collapsed,
      }),
    },
  ),
);
