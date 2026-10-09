import { create } from "zustand";
import { persist } from "zustand/middleware";

/** What the content area shows. Derived into the UiContext sent with List/Invoke. */
export type Selection =
  | { kind: "none" }
  | { kind: "terminal"; id: string }
  | { kind: "session"; id: string }
  | { kind: "repo"; repoId: string }
  | { kind: "worktree"; repoId: string; path: string }
  /** A top-level page that is not a sidebar row (see components/prs). */
  | { kind: "view"; name: string };

/** Top-level page names (UiIntent.ShowView); unknown names are ignored. */
export const viewNames: readonly string[] = ["pullrequests"];

/** Which region has keyboard focus; the palette returns focus to it on close. */
export type FocusRegion = "sidebar" | "terminal" | "content" | "palette" | "panel";

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 520;
/** Side panel width bounds; the upper bound is also a share of the window (panelMax). */
export const PANEL_MIN = 280;
export const PANEL_MAX_FRACTION = 0.6;
export const PANEL_DEFAULT = 420;
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
  /** Row key the sidebar keyboard cursor is on. */
  cursorKey: string | null;
  collapsed: Readonly<Record<string, boolean>>;
  palette: { open: boolean; query: string; commandName: string | null; returnTo: FocusRegion };
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
  closePalette: () => void;
  setRenaming: (sessionId: string | null) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setPanelWidth: (w: number, windowWidth?: number) => void;
  setFontSize: (n: number) => void;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Widest the side panel may be in a window this wide (never below PANEL_MIN). */
export function panelMax(windowWidth: number): number {
  return Math.max(PANEL_MIN, Math.floor(windowWidth * PANEL_MAX_FRACTION));
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
      cursorKey: null,
      collapsed: {},
      palette: { open: false, query: "", commandName: null, returnTo: "content" },
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
        set((s) => ({ palette: { open: true, query, commandName, returnTo: s.palette.open ? s.palette.returnTo : s.focus } }));
      },
      closePalette: () => {
        // Hand focus back to where it was before the palette opened.
        set((s) => ({
          palette: { open: false, query: "", commandName: null, returnTo: "content" },
          terminalFocusSeq: s.palette.returnTo === "terminal" ? s.terminalFocusSeq + 1 : s.terminalFocusSeq,
          sidebarFocusSeq: s.palette.returnTo === "sidebar" ? s.sidebarFocusSeq + 1 : s.sidebarFocusSeq,
        }));
      },
      toggleSidebar: () => {
        set((s) => ({ sidebarVisible: !s.sidebarVisible }));
      },
      setSidebarWidth: (w) => {
        set({ sidebarWidth: clamp(Math.round(w), SIDEBAR_MIN, SIDEBAR_MAX) });
      },
      setPanelWidth: (w, windowWidth = window.innerWidth) => {
        set({ panelWidth: clamp(Math.round(w), PANEL_MIN, panelMax(windowWidth)) });
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
