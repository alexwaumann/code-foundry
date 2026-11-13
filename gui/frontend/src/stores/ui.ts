import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UiContextView } from "@/api/command";
import { bool, finite, persistedRecord } from "./persisted";

/**
 * What the window shows: the focused tab's selection (stores/selectionBridge.ts writes it, and
 * select() opens or focuses a selection's tab). Derived into the UiContext sent with List/Invoke.
 * A terminal is never selected: it is a tab of its own.
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
  /**
   * A top-level page that is not a sidebar row (see components/prs). The Projects pages
   * (`name` "projects") are the index without an id, a project's page with `projectId`,
   * a workspace's page with `workspaceId` (components/projects/ProjectsPage.tsx).
   */
  | { kind: "view"; name: string; projectId?: string; workspaceId?: string };

/** The Projects index (every project and workspace as a row). */
export const PROJECTS_INDEX: Extract<Selection, { kind: "view" }> = { kind: "view", name: "projects" };

/** A project's page on the Projects view. */
export function projectPage(projectId: string): Extract<Selection, { kind: "view" }> {
  return { kind: "view", name: "projects", projectId };
}

/** A workspace's page on the Projects view. */
export function workspacePage(workspaceId: string): Extract<Selection, { kind: "view" }> {
  return { kind: "view", name: "projects", workspaceId };
}

/** The selection is one of the Projects pages: the index, a project's or a workspace's. */
export function isProjectsView(sel: Selection): sel is Extract<Selection, { kind: "view" }> {
  return sel.kind === "view" && sel.name === "projects";
}

/** Top-level page names (UiIntent.ShowView); unknown names are ignored. */
export const viewNames: readonly string[] = ["pullrequests", "projects", "ember"];

/**
 * The window's home: the new-thread composer on No project (the project picker closed).
 * What the window selects when it loads and when its selection goes away (an archived,
 * snoozed or removed thread, a composer cancelled with nothing typed); `none` renders it
 * too (App.tsx). Selections are not persisted. See docs/notes/remove-dashboard.md.
 */
export const HOME: Extract<Selection, { kind: "compose" }> = { kind: "compose", projectId: "", noProject: true };

/** Which region has keyboard focus; the palette returns focus to it on close. */
export type FocusRegion = "sidebar" | "content" | "palette";

/**
 * What the palette dialog shows: the command list (and arg prompts), the project picker,
 * the member picker of "Run in…" (for `palette.threadId`), the previous prompts
 * (composer.history; components/palette/PromptsPicker.tsx), or the file finder over
 * `palette.threadId` (file.find; components/palette/FileFinder.tsx), or the Find dialog
 * over every thread (search.open; components/search/SearchDialog.tsx).
 */
export type PalettePage = "commands" | "projects" | "runin" | "prompts" | "files" | "search";

/** The sidebar's width bounds (its resize handle). */
export const SIDEBAR_MIN = 260;
export const SIDEBAR_MAX = 520;
/** The initial width, and what double-clicking the resize handle restores. */
export const SIDEBAR_DEFAULT = 260;
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
  /**
   * Incremented to ask the selected thread's prompt to take focus (its composer,
   * components/thread/ThreadComposer.tsx): a thread picked from the sidebar, a palette
   * jump, a focusThread intent.
   */
  promptFocusSeq: number;
  /** Incremented to ask the sidebar list to take focus. */
  sidebarFocusSeq: number;
  /**
   * Incremented to ask the focused pane's tab to take focus: a thread's prompt (ThreadComposer),
   * else the surface's own focus root (shell/paneContext.ts).
   */
  contentFocusSeq: number;
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
  /** Terminal font size in px before zoom (appearance.font_size). */
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
  /** Ember's chat opens every "Worked for" row (components/ember/EmberPane.tsx "Show work"). */
  emberShowWork: boolean;

  /** Selects; `focusPrompt` also asks a thread's prompt to take focus (promptFocusSeq). */
  select: (sel: Selection, opts?: SelectOptions) => void;
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
  /** Opens the palette on the file finder over a thread (file.find's presenter). */
  openFilesPalette: (threadId: string) => void;
  /** Opens the palette on the Find dialog over every thread (search.open's presenter). */
  openSearchPalette: () => void;
  /**
   * Closes the palette. The keyboard goes back to the region it came from (a thread's prompt for
   * the content), where a command run from the palette may have moved that target first.
   * `restore` (Escape, the backdrop, the file finder's pick): back to the very element that had
   * it, a diff, a terminal tab or the quick terminal included (takePaletteRestore).
   */
  closePalette: (restore?: boolean) => void;
  focusComposer: () => void;
  setRenaming: (threadId: string | null) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  focusContent: () => void;
  setFontSize: (n: number) => void;
  setZoom: (percent: number) => void;
  setUsageRange: (days: UsageRange) => void;
  toggleWorkingCollapsed: () => void;
  toggleArchivedCollapsed: () => void;
  toggleSnoozedCollapsed: () => void;
  setEmberShowWork: (on: boolean) => void;
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

/** The sidebar's rendered width: 0 when hidden. */
export function visibleSidebarWidth(s: { sidebarVisible: boolean; sidebarWidth: number }): number {
  return s.sidebarVisible ? s.sidebarWidth : 0;
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
      return a.name === (b as typeof a).name && (a.projectId ?? "") === ((b as typeof a).projectId ?? "") && (a.workspaceId ?? "") === ((b as typeof a).workspaceId ?? "");
  }
}

/**
 * How a selection is asked for. A thread sent from a compose tab takes that tab's place through
 * the send itself (thread.new --compose, stores/compose.ts sendDraft), never through a selection.
 */
export interface SelectOptions {
  focusPrompt?: boolean;
}

/**
 * Takes a select() instead of the store: with the window shell on, the selection bridge
 * (stores/selectionBridge.ts) opens or focuses the selection's tab, and the selection follows
 * the focused tab (mirrorSelection). Answers false to leave the selection to the store.
 */
export type SelectRoute = (sel: Selection, opts: SelectOptions) => boolean;

let selectRoute: SelectRoute | null = null;

/** The element that had the keyboard when the palette opened; null while it is closed or had none. */
let paletteReturn: HTMLElement | null = null;
/** The element a closed palette hands the keyboard back to, until the palette takes it (takePaletteRestore). */
let pendingRestore: HTMLElement | null = null;

/** As the palette opens (not when it switches page): where the keyboard was. */
function noteReturn(open: boolean): void {
  if (open) return;
  const el = typeof document === "undefined" ? null : document.activeElement;
  paletteReturn = el instanceof HTMLElement && el !== document.body ? el : null;
}

/**
 * Where the user's keyboard is: the focused element, or while the palette is open the one that
 * had it when it opened (the command context reads it: stores/context.ts).
 */
export function keyboardElement(): Element | null {
  if (useUiStore.getState().palette.open) return paletteReturn;
  return typeof document === "undefined" ? null : document.activeElement;
}

/** The element closePalette(true) hands the keyboard back to, once (the palette's close takes it). */
export function takePaletteRestore(): HTMLElement | null {
  const el = pendingRestore;
  pendingRestore = null;
  return el?.isConnected ? el : null;
}

/** Installs (or with null removes) the route select() goes through first. */
export function setSelectRoute(route: SelectRoute | null): void {
  selectRoute = route;
}

/**
 * Sets the selection without the route: the selection bridge mirrors the focused tab with it.
 */
export function mirrorSelection(sel: Selection, opts: { focusPrompt?: boolean } = {}): void {
  useUiStore.setState((s) => selectionUpdate(s, sel, { focusPrompt: opts.focusPrompt }));
}

/** The state a selection change sets. */
function selectionUpdate(s: UiState, sel: Selection, opts: { focusPrompt?: boolean }): Partial<UiState> {
  return {
    selection: sameSelection(s.selection, sel) ? s.selection : sel,
    promptFocusSeq: opts.focusPrompt && sel.kind === "thread" ? s.promptFocusSeq + 1 : s.promptFocusSeq,
  };
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      selection: HOME,
      focus: "content",
      promptFocusSeq: 0,
      sidebarFocusSeq: 0,
      contentFocusSeq: 0,
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
      emberShowWork: false,

      select: (sel, opts) => {
        if (selectRoute?.(sel, opts ?? {})) return;
        set((s) => selectionUpdate(s, sel, { focusPrompt: opts?.focusPrompt }));
      },
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
        noteReturn(get().palette.open);
        set((s) => ({ palette: { open: true, query, commandName, page: "commands", returnTo: s.palette.open ? s.palette.returnTo : s.focus, ...(context ? { context } : {}) } }));
      },
      openProjectPicker: (returnTo) => {
        noteReturn(get().palette.open);
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "projects", returnTo: returnTo ?? (s.palette.open ? s.palette.returnTo : s.focus) } }));
      },
      openRunInPicker: (threadId, returnTo) => {
        noteReturn(get().palette.open);
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "runin", threadId, returnTo: returnTo ?? (s.palette.open ? s.palette.returnTo : s.focus) } }));
      },
      openPromptsPalette: () => {
        noteReturn(get().palette.open);
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "prompts", returnTo: s.palette.open ? s.palette.returnTo : s.focus } }));
      },
      openFilesPalette: (threadId) => {
        noteReturn(get().palette.open);
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "files", threadId, returnTo: s.palette.open ? s.palette.returnTo : s.focus } }));
      },
      openSearchPalette: () => {
        noteReturn(get().palette.open);
        set((s) => ({ palette: { open: true, query: "", commandName: null, page: "search", returnTo: s.palette.open ? s.palette.returnTo : s.focus } }));
      },
      focusComposer: () => {
        set((s) => ({ composerFocusSeq: s.composerFocusSeq + 1 }));
      },
      closePalette: (restore = false) => {
        // Hand focus back to where it was before the palette opened. A command run from
        // the palette may move that target first.
        const back = paletteReturn;
        paletteReturn = null;
        pendingRestore = restore && back?.isConnected ? back : null;
        const exact = pendingRestore !== null;
        set((s) => {
          const to = s.palette.returnTo;
          return {
            palette: { open: false, query: "", commandName: null, page: "commands", returnTo: "content" },
            sidebarFocusSeq: to === "sidebar" && !exact ? s.sidebarFocusSeq + 1 : s.sidebarFocusSeq,
            contentFocusSeq: to === "content" && !exact ? s.contentFocusSeq + 1 : s.contentFocusSeq,
          };
        });
      },
      toggleSidebar: () => {
        set((s) => ({ sidebarVisible: !s.sidebarVisible }));
      },
      setSidebarWidth: (w) => {
        set({ sidebarWidth: clamp(Math.round(w), SIDEBAR_MIN, SIDEBAR_MAX) });
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
    }),
    {
      name: "code-foundry.ui",
      // 2: the global panelWidth moved to per-panel widths in the panel store; drop it.
      // 3: the sidebar is a flat thread list (no collapsible projects or worktrees); drop collapsed.
      // The Projects index has no collapsible projects and the workspace page no collapsible
      // card: collapsedProjects and collapsedWorkspaces are ignored (merge).
      // 4: the default sidebar width fell from 280 (it is SIDEBAR_DEFAULT now); drop the saved
      // width once so every window starts at the default, and keep widths dragged after that.
      version: 4,
      migrate: (persisted, version) => {
        const { panelWidth: _old, collapsed: _gone, ...rest } = persistedRecord(persisted);
        if (version < 4) delete rest.sidebarWidth;
        return rest as Partial<UiState> as UiState;
      },
      // Only the persisted fields, each checked (stores/persisted.ts): a store another build
      // wrote, or a hand edit, never puts a wrong-typed value in the window's state. Numbers
      // are clamped: a saved width outside [SIDEBAR_MIN, SIDEBAR_MAX] (e.g. 220, saved before
      // the minimum rose to 260) renders and drags from a valid width.
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
        emberShowWork: s.emberShowWork,
      }),
    },
  ),
);
