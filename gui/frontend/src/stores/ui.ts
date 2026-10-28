import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UiContextView } from "@/api/command";
import { SHELL_GAP } from "@/design/tokens";
import { bool, finite, persistedRecord } from "./persisted";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { useWorkspacesStore } from "./workspaces";

/**
 * What the content area shows. Derived into the UiContext sent with List/Invoke. A shell
 * is never selected: it shows in its owner's bottom panel (a thread's, or the Projects
 * page's; stores/bottomPanel.ts).
 */
export type Selection =
  | { kind: "none" }
  | { kind: "thread"; id: string }
  /**
   * The new-thread composer (picked in the project picker): for a project, or with
   * workspaceId for a workspace, projectId then being a member's (for the command context),
   * or with noProject for a thread without a project (projectId ""), or with likeThreadId
   * for "New thread on this branch" (that thread's set; projectId its primary).
   */
  | { kind: "compose"; projectId: string; workspaceId?: string; noProject?: boolean; likeThreadId?: string }
  /** A top-level page that is not a sidebar row (see components/prs). */
  | { kind: "view"; name: string };

/** Top-level page names (UiIntent.ShowView); unknown names are ignored. */
export const viewNames: readonly string[] = ["dashboard", "pullrequests", "projects", "ember"];

/**
 * The dashboard page (view.dashboard): what the window selects when it loads and when its
 * selection goes away. `none` still renders the same page (App.tsx), but only this one
 * highlights the sidebar's Dashboard button. Selections are not persisted.
 */
export const DASHBOARD: Selection = { kind: "view", name: "dashboard" };

export function isDashboard(sel: Selection): boolean {
  return sel.kind === "none" || (sel.kind === "view" && sel.name === "dashboard");
}

/** Which region has keyboard focus; the palette returns focus to it on close. */
export type FocusRegion = "sidebar" | "content" | "palette" | "panel" | "bottom";

/**
 * What the palette dialog shows: the command list (and arg prompts), the project picker,
 * the member picker of "Run in…" (for `palette.threadId`), or the previous prompts
 * (composer.history; components/palette/PromptsPicker.tsx).
 */
export type PalettePage = "commands" | "projects" | "runin" | "prompts";

/**
 * The sidebar band must fit the 80px traffic-light gutter and the app name
 * (components/sidebar/Sidebar.tsx); the toolbar below it is four icon buttons.
 */
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 520;
/** The initial width, and what double-clicking the resize handle restores. */
export const SIDEBAR_DEFAULT = 280;
/** Side panel width bounds; the upper bound depends on the window and sidebar (panelMax). */
export const PANEL_MIN = 280;
export const PANEL_MAX_FRACTION = 0.6;
export const PANEL_DEFAULT = 420;
/**
 * The width a tab group needs to be worth reading side by side: CONTENT_MIN, the least the
 * content pane gets. PANEL_MIN (narrower) stays the CSS minimum a side-by-side group is
 * squeezed to by the split's ratio.
 */
export const PANEL_GROUP_SIDE_MIN = 360;
/**
 * A split side panel shows its two tab groups side by side from this rendered width (two
 * PANEL_GROUP_SIDE_MIN groups and the 1px divider), stacked below it, expanded or not
 * (components/panel/splitLayout.ts).
 */
export const PANEL_SIDE_BY_SIDE_MIN = 2 * PANEL_GROUP_SIDE_MIN + 1;
/** A stacked split panel's tab group is never shorter than this (its header and some body). */
export const PANEL_GROUP_MIN_HEIGHT = 160;
/** The content pane never gets narrower than this to make room for the side panel. */
export const CONTENT_MIN = 360;
/**
 * Horizontal gaps around the panes when the side panel shows: the content pane's margins
 * on both sides plus the panel's right margin (App.tsx m-shell, SidePanel.tsx mr-shell),
 * three shell gaps.
 */
export const PANE_GAPS = 3 * SHELL_GAP;
/**
 * Bottom panel height bounds (components/bottom): the upper bound is a share of the
 * content column's measured height (bottomMax).
 */
export const BOTTOM_MIN = 120;
export const BOTTOM_DEFAULT = 280;
export const BOTTOM_MAX_FRACTION = 0.7;
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

/** How many selections back/forward (view.back, view.forward) remember; the oldest go first. */
export const HISTORY_MAX = 50;

interface UiState {
  selection: Selection;
  /**
   * The selections this window visited, oldest first, for view.back and view.forward
   * (docs/notes/selection-history.md): browser semantics, `historyIndex` being the current
   * one. Not persisted, like the selection: a window starts with just the dashboard.
   */
  history: Selection[];
  historyIndex: number;
  focus: FocusRegion;
  /**
   * Incremented to ask the selected thread's prompt to take focus (its composer,
   * components/thread/ThreadComposer.tsx): a thread picked from the sidebar, a palette
   * jump, a focusThread intent.
   */
  promptFocusSeq: number;
  /** Incremented to ask the sidebar list to take focus. */
  sidebarFocusSeq: number;
  /** Incremented to ask the visible side panel to take focus (components/panel/SidePanel.tsx). */
  panelFocusSeq: number;
  /**
   * Incremented to ask the visible bottom panel to take focus: its active terminal, else
   * the panel itself (components/bottom/BottomPanel.tsx).
   */
  bottomFocusSeq: number;
  /**
   * Incremented to ask whatever fills the content pane to take focus: a thread's prompt
   * (ThreadComposer), else the page's `[data-focus-root]` element (App.tsx).
   */
  contentFocusSeq: number;
  /** window.innerWidth, kept current by startApp; bounds the side panel (panelMax). */
  windowWidth: number;
  /** Row key the sidebar keyboard cursor is on. */
  cursorKey: string | null;
  /**
   * `context`: the command context the palette lists and invokes in, instead of the
   * selection's (a Projects page row's action on its own project).
   */
  palette: { open: boolean; query: string; commandName: string | null; page: PalettePage; returnTo: FocusRegion; threadId?: string; context?: UiContextView };
  /** Incremented to ask the composer to take focus. */
  composerFocusSeq: number;
  /** Thread whose sidebar row is in inline-rename mode. */
  renamingThreadId: string | null;

  // Persisted settings.
  sidebarVisible: boolean;
  sidebarWidth: number;
  /** Terminal font size in px before zoom (appearance.font_size); the bottom panel's shells. */
  fontSize: number;
  /** Page zoom in percent (appearance.zoom). */
  zoom: number;
  /** The Usage page's range control. */
  usageRange: UsageRange;
  /** The sidebar's Working section is collapsed (its threads hidden; the header counts them). */
  workingCollapsed: boolean;
  /** The sidebar's Archived section is collapsed (its threads hidden; the header counts them). Collapsed by default. */
  archivedCollapsed: boolean;
  /** The sidebar's Snoozed section is collapsed (its threads hidden; the header counts them). Collapsed by default. */
  snoozedCollapsed: boolean;
  /** Projects page: project ids whose worktree rows are hidden (the header counts them). */
  collapsedProjects: string[];
  /** Projects page: workspace ids whose member rows are hidden. */
  collapsedWorkspaces: string[];
  /** Ember's chat opens every "Worked for" row (components/ember/EmberPane.tsx "Show work"). */
  emberShowWork: boolean;

  /** Selects; `focusPrompt` also asks a thread's prompt to take focus (promptFocusSeq). */
  select: (sel: Selection, opts?: { focusPrompt?: boolean }) => void;
  /**
   * view.back: selects the entry before the current one in `history`, skipping (and
   * dropping) ones whose thread, project or workspace is gone. False when there is none.
   */
  back: () => boolean;
  /** view.forward: selects the entry after the current one, like back. False when there is none. */
  forward: () => boolean;
  setFocus: (f: FocusRegion) => void;
  focusSidebar: () => void;
  setCursor: (key: string | null) => void;
  openPalette: (query?: string, commandName?: string | null, context?: UiContextView) => void;
  /** Opens the palette on the project picker (thread.new's presenter). */
  openProjectPicker: (returnTo?: FocusRegion) => void;
  /** Opens the palette on the "Run in…" member picker for a thread (thread.run-in's presenter). */
  openRunInPicker: (threadId: string, returnTo?: FocusRegion) => void;
  /** Opens the palette on the previous prompts (composer.history's presenter without a focused composer). */
  openPromptsPalette: () => void;
  closePalette: () => void;
  focusComposer: () => void;
  setRenaming: (threadId: string | null) => void;
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
  setUsageRange: (days: UsageRange) => void;
  toggleWorkingCollapsed: () => void;
  toggleArchivedCollapsed: () => void;
  toggleSnoozedCollapsed: () => void;
  setEmberShowWork: (on: boolean) => void;
  /** Collapses (true) or expands a project on the Projects page; false when it already was. */
  setProjectCollapsed: (projectId: string, collapsed: boolean) => boolean;
  /** Collapses (true) or expands a workspace on the Projects page; false when it already was. */
  setWorkspaceCollapsed: (workspaceId: string, collapsed: boolean) => boolean;
  /** Drops collapsed workspaces that no longer exist (a removal, a snapshot without them). */
  pruneCollapsedWorkspaces: (exists: (workspaceId: string) => boolean) => void;
}

/** `ids` with `id` in (collapsed) or out; the same array when nothing changes. */
function withMember(ids: string[], id: string, member: boolean): string[] {
  if (ids.includes(id) === member) return ids;
  return member ? [...ids, id] : ids.filter((x) => x !== id);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** The Usage page's ranges in days (UTC days, today inclusive); 30 by default. */
export const USAGE_RANGES = [1, 7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export const USAGE_RANGE_DEFAULT: UsageRange = 30;

function isUsageRange(n: unknown): n is UsageRange {
  return USAGE_RANGES.some((r) => r === n);
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

/**
 * The expanded side panel's rendered width: it replaces the content column, so it fills
 * the row beside a sidebar this wide (0 when hidden), less its own shell-gap margins on
 * both sides (SidePanel.tsx m-shell).
 */
export function expandedPanelWidth(windowWidth: number, sidebarWidth: number): number {
  return Math.max(0, windowWidth - sidebarWidth - 2 * SHELL_GAP);
}

/** The content pane keeps at least this much height above the bottom panel. */
export const MAIN_MIN_HEIGHT = 160;
/** The gap between the content pane and the bottom panel (components/bottom: mt-shell). */
export const BOTTOM_GAP = SHELL_GAP;

/**
 * Tallest the bottom panel may be: 70% of the content column (main pane, gap and bottom
 * pane together), and no more than leaves MAIN_MIN_HEIGHT for the content pane above the
 * gap. Never below BOTTOM_MIN.
 */
export function bottomMax(columnHeight: number): number {
  return Math.max(BOTTOM_MIN, Math.min(Math.floor(columnHeight * BOTTOM_MAX_FRACTION), Math.floor(columnHeight - MAIN_MIN_HEIGHT - BOTTOM_GAP)));
}

/** A bottom panel height clamped to [BOTTOM_MIN, bottomMax(columnHeight)]. */
export function clampBottomHeight(h: number, columnHeight: number): number {
  return clamp(Math.round(h), BOTTOM_MIN, bottomMax(columnHeight));
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
    case "thread":
      return a.id === (b as typeof a).id;
    case "compose":
      return a.projectId === (b as typeof a).projectId && a.workspaceId === (b as typeof a).workspaceId && Boolean(a.noProject) === Boolean((b as typeof a).noProject) && a.likeThreadId === (b as typeof a).likeThreadId;
    case "view":
      return a.name === (b as typeof a).name;
  }
}

/**
 * Whether a remembered selection can no longer be shown: a removed thread (an archived one
 * still exists), or a composer whose project or workspace was removed. Unknown before the
 * store holding it has loaded.
 */
function gone(sel: Selection): boolean {
  switch (sel.kind) {
    case "thread": {
      const threads = useThreadsStore.getState();
      return threads.loaded && !(sel.id in threads.byId);
    }
    case "compose": {
      if (sel.likeThreadId) {
        const threads = useThreadsStore.getState();
        return threads.loaded && !(sel.likeThreadId in threads.byId);
      }
      if (sel.workspaceId) {
        const workspaces = useWorkspacesStore.getState();
        return workspaces.loaded && !(sel.workspaceId in workspaces.byId);
      }
      if (sel.noProject) return false;
      const projects = useProjectsStore.getState();
      return projects.loaded && !(sel.projectId in projects.byId);
    }
    default:
      return false;
  }
}

/**
 * `history` without the entries that are gone (the current one stays, whatever it is) and
 * with the duplicates that leaves next to each other collapsed; `index` follows the current
 * entry.
 */
export function pruneHistory(history: readonly Selection[], index: number, isGone: (sel: Selection) => boolean = gone): { history: Selection[]; index: number } {
  const out: Selection[] = [];
  let at = 0;
  history.forEach((e, i) => {
    if (i !== index && isGone(e)) return;
    const last = out[out.length - 1];
    if (last && sameSelection(last, e)) {
      if (i === index) at = out.length - 1;
      return;
    }
    if (i === index) at = out.length;
    out.push(e);
  });
  return { history: out, index: at };
}

/**
 * The state a selection change sets. `push` (a normal select) records it after the current
 * history entry, dropping the forward ones, unless it is the current entry already; back
 * and forward move the index themselves and do not push.
 */
function selectionUpdate(s: UiState, sel: Selection, opts: { focusPrompt?: boolean; push: boolean }): Partial<UiState> {
  const next: Partial<UiState> = {
    selection: sameSelection(s.selection, sel) ? s.selection : sel,
    promptFocusSeq: opts.focusPrompt && sel.kind === "thread" ? s.promptFocusSeq + 1 : s.promptFocusSeq,
  };
  const current = s.history[s.historyIndex];
  if (!opts.push || (current && sameSelection(current, sel))) return next;
  const history = [...s.history.slice(0, s.historyIndex + 1), sel].slice(-HISTORY_MAX);
  return { ...next, history, historyIndex: history.length - 1 };
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      selection: DASHBOARD,
      history: [DASHBOARD],
      historyIndex: 0,
      focus: "content",
      promptFocusSeq: 0,
      sidebarFocusSeq: 0,
      panelFocusSeq: 0,
      bottomFocusSeq: 0,
      contentFocusSeq: 0,
      windowWidth: typeof window === "undefined" ? 1280 : window.innerWidth,
      cursorKey: null,
      palette: { open: false, query: "", commandName: null, page: "commands", returnTo: "content" },
      composerFocusSeq: 0,
      renamingThreadId: null,
      sidebarVisible: true,
      sidebarWidth: SIDEBAR_DEFAULT,
      fontSize: FONT_DEFAULT,
      zoom: ZOOM_DEFAULT,
      usageRange: USAGE_RANGE_DEFAULT,
      workingCollapsed: false,
      archivedCollapsed: true,
      snoozedCollapsed: true,
      collapsedProjects: [],
      collapsedWorkspaces: [],
      emberShowWork: false,

      select: (sel, opts) => {
        set((s) => selectionUpdate(s, sel, { focusPrompt: opts?.focusPrompt, push: true }));
      },
      back: () => stepHistory(-1),
      forward: () => stepHistory(1),
      setRenaming: (renamingThreadId) => {
        set({ renamingThreadId });
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
      openPalette: (query = "", commandName = null, context) => {
        set((s) => ({ palette: { open: true, query, commandName, page: "commands", returnTo: s.palette.open ? s.palette.returnTo : s.focus, ...(context ? { context } : {}) } }));
      },
      openProjectPicker: (returnTo) => {
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "projects", returnTo: returnTo ?? (s.palette.open ? s.palette.returnTo : s.focus) } }));
      },
      openRunInPicker: (threadId, returnTo) => {
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "runin", threadId, returnTo: returnTo ?? (s.palette.open ? s.palette.returnTo : s.focus) } }));
      },
      openPromptsPalette: () => {
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "prompts", returnTo: s.palette.open ? s.palette.returnTo : s.focus } }));
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
            sidebarFocusSeq: to === "sidebar" ? s.sidebarFocusSeq + 1 : s.sidebarFocusSeq,
            panelFocusSeq: to === "panel" ? s.panelFocusSeq + 1 : s.panelFocusSeq,
            bottomFocusSeq: to === "bottom" ? s.bottomFocusSeq + 1 : s.bottomFocusSeq,
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
      setUsageRange: (usageRange) => {
        set({ usageRange });
      },
      toggleWorkingCollapsed: () => {
        set((s) => ({ workingCollapsed: !s.workingCollapsed }));
      },
      toggleArchivedCollapsed: () => {
        set((s) => ({ archivedCollapsed: !s.archivedCollapsed }));
      },
      toggleSnoozedCollapsed: () => {
        set((s) => ({ snoozedCollapsed: !s.snoozedCollapsed }));
      },
      setEmberShowWork: (emberShowWork) => {
        set({ emberShowWork });
      },
      setProjectCollapsed: (projectId, collapsed) => {
        const prev = get().collapsedProjects;
        const next = withMember(prev, projectId, collapsed);
        if (next === prev) return false;
        set({ collapsedProjects: next });
        return true;
      },
      setWorkspaceCollapsed: (workspaceId, collapsed) => {
        const prev = get().collapsedWorkspaces;
        const next = withMember(prev, workspaceId, collapsed);
        if (next === prev) return false;
        set({ collapsedWorkspaces: next });
        return true;
      },
      pruneCollapsedWorkspaces: (exists) => {
        const prev = get().collapsedWorkspaces;
        const next = prev.filter(exists);
        if (next.length !== prev.length) set({ collapsedWorkspaces: next });
      },
    }),
    {
      name: "code-foundry.ui",
      // 2: the global panelWidth moved to per-panel widths in the panel store; drop it.
      // 3: the sidebar is a flat thread list (no collapsible projects or worktrees); drop collapsed.
      version: 3,
      migrate: (persisted) => {
        const { panelWidth: _old, collapsed: _gone, ...rest } = (persisted ?? {}) as Record<string, unknown>;
        return rest as Partial<UiState> as UiState;
      },
      // Only the persisted fields, each checked (stores/persisted.ts): a store another build
      // wrote, or a hand edit, never puts a wrong-typed value in the window's state. Numbers
      // are clamped: a saved width outside [SIDEBAR_MIN, SIDEBAR_MAX] (e.g. 180, saved before
      // the minimum rose to 220) renders and drags from a valid width.
      merge: (persisted, current) => {
        const p = persistedRecord(persisted);
        const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
          const n = finite(v);
          return n === undefined ? fallback : clamp(Math.round(n), lo, hi);
        };
        return {
          ...current,
          sidebarVisible: bool(p.sidebarVisible, current.sidebarVisible),
          sidebarWidth: num(p.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX, current.sidebarWidth),
          fontSize: num(p.fontSize, FONT_MIN, FONT_MAX, current.fontSize),
          zoom: num(p.zoom, ZOOM_MIN, ZOOM_MAX, current.zoom),
          usageRange: isUsageRange(p.usageRange) ? p.usageRange : current.usageRange,
          workingCollapsed: bool(p.workingCollapsed, current.workingCollapsed),
          archivedCollapsed: bool(p.archivedCollapsed, current.archivedCollapsed),
          snoozedCollapsed: bool(p.snoozedCollapsed, current.snoozedCollapsed),
          collapsedProjects: isStringArray(p.collapsedProjects) ? p.collapsedProjects : current.collapsedProjects,
          collapsedWorkspaces: isStringArray(p.collapsedWorkspaces) ? p.collapsedWorkspaces : current.collapsedWorkspaces,
          emberShowWork: bool(p.emberShowWork, current.emberShowWork),
        };
      },
      partialize: (s) => ({
        sidebarVisible: s.sidebarVisible,
        sidebarWidth: s.sidebarWidth,
        fontSize: s.fontSize,
        zoom: s.zoom,
        usageRange: s.usageRange,
        workingCollapsed: s.workingCollapsed,
        archivedCollapsed: s.archivedCollapsed,
        snoozedCollapsed: s.snoozedCollapsed,
        collapsedProjects: s.collapsedProjects,
        collapsedWorkspaces: s.collapsedWorkspaces,
        emberShowWork: s.emberShowWork,
      }),
    },
  ),
);

/** Moves through history by one live entry (view.back, view.forward); false, after pruning, when there is none. */
function stepHistory(by: 1 | -1): boolean {
  const s = useUiStore.getState();
  const { history, index } = pruneHistory(s.history, s.historyIndex);
  const target = history[index + by];
  if (!target) {
    if (history.length !== s.history.length) useUiStore.setState({ history, historyIndex: index });
    return false;
  }
  useUiStore.setState((cur) => ({ ...selectionUpdate(cur, target, { focusPrompt: true, push: false }), history, historyIndex: index + by }));
  return true;
}
