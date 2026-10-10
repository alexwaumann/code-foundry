/**
 * The side panel ("surface panel") to the right of the content pane. Each selection
 * (session, terminal, worktree, repo, top-level page) has its own panel: whether it is
 * open, its tabs, the active tab, its width, and whether it is expanded to the full width
 * of the content area. Switching selection shows that
 * selection's panel. All of it is persisted (localStorage "code-foundry.panel"), so it
 * survives a reload. Entries are never pruned: a deleted session's panel stays stored.
 * See docs/notes/side-panel.md.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PANEL_DEFAULT, clampPanelWidth, isDashboard, useUiStore, visibleSidebarWidth, type Selection } from "./ui";

/**
 * What a panel tab shows: a SurfaceSpec kind from surfaces/registry.ts. A plain string,
 * so adding a surface adds files there and edits nothing here.
 */
export type SurfaceKind = string;

export interface Tab {
  /** Deterministic from kind + params (tabId), so opening the same thing twice finds it. */
  id: string;
  kind: SurfaceKind;
  title: string;
  params: Readonly<Record<string, string>>;
}

export interface PanelEntry {
  open: boolean;
  tabs: readonly Tab[];
  activeTabId: string | null;
  /**
   * Stored width, clamped to [PANEL_MIN, panelMax] when it was set. Absent means
   * PANEL_DEFAULT. The panel renders at min(width, panelMax), so a width saved in a wider
   * window comes back when there is room again.
   */
  width?: number;
  /**
   * Fills the content area (the content pane hides) while open. Absent means false: the
   * reducers drop it rather than store false, so entries saved before it existed and
   * entries never expanded look the same. Hiding the panel keeps it.
   */
  expanded?: boolean;
}

export const emptyEntry: PanelEntry = { open: false, tabs: [], activeTabId: null };

/** Panel key for a selection; null for the dashboard (or `none`), which has no panel. */
export function keyOf(sel: Selection): string | null {
  if (isDashboard(sel)) return null;
  switch (sel.kind) {
    case "none":
      return null;
    case "session":
      return `session:${sel.id}`;
    case "terminal":
      return `terminal:${sel.id}`;
    case "repo":
      return `repo:${sel.repoId}`;
    case "worktree":
      return `worktree:${sel.repoId}:${sel.path}`;
    case "view":
      return `view:${sel.name}`;
    case "compose":
      return sel.workspaceId ? `compose:ws:${sel.workspaceId}` : `compose:${sel.repoId}`;
  }
}

/** Stable tab id: the kind plus its params sorted by name, e.g. `pullrequest?number=12`. */
export function tabId(kind: SurfaceKind, params: Readonly<Record<string, string>> = {}): string {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] ?? "")}`)
    .join("&");
  return query ? `${kind}?${query}` : kind;
}

/** A tab with its id derived from kind + params. */
export function makeTab(kind: SurfaceKind, title: string, params: Readonly<Record<string, string>> = {}): Tab {
  return { id: tabId(kind, params), kind, title, params };
}

/** Opens the panel with the tab active. An existing tab with the same id is reused (its title refreshed). */
export function openTab(e: PanelEntry, tab: Tab): PanelEntry {
  const i = e.tabs.findIndex((t) => t.id === tab.id);
  const tabs = i < 0 ? [...e.tabs, tab] : e.tabs[i]?.title === tab.title ? e.tabs : e.tabs.map((t, j) => (j === i ? { ...t, title: tab.title } : t));
  return { ...e, open: true, tabs, activeTabId: tab.id };
}

/**
 * Removes a tab. Closing the active tab activates its right neighbour, else the left one.
 * Closing the last tab hides the panel. An unknown id changes nothing.
 */
export function closeTab(e: PanelEntry, id: string): PanelEntry {
  const i = e.tabs.findIndex((t) => t.id === id);
  if (i < 0) return e;
  const tabs = e.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return { ...e, open: false, tabs, activeTabId: null };
  if (e.activeTabId !== id) return { ...e, tabs };
  const next = tabs[i] ?? tabs[i - 1] ?? null;
  return { ...e, tabs, activeTabId: next?.id ?? null };
}

/** Makes an existing tab active; an unknown id changes nothing. */
export function activateTab(e: PanelEntry, id: string): PanelEntry {
  if (e.activeTabId === id || !e.tabs.some((t) => t.id === id)) return e;
  return { ...e, activeTabId: id };
}

/** Shows or hides the panel (flips it without `open`). Tabs are kept either way. */
export function toggle(e: PanelEntry, open?: boolean): PanelEntry {
  const next = open ?? !e.open;
  return next === e.open ? e : { ...e, open: next };
}

/** Sets the stored width (already clamped by the caller); undefined drops it, back to PANEL_DEFAULT. */
export function setWidth(e: PanelEntry, width: number | undefined): PanelEntry {
  if (e.width === width) return e;
  if (width !== undefined) return { ...e, width };
  const { width: _old, ...rest } = e;
  return rest;
}

/** Expands (true), restores the split (false), or flips it (undefined). Open state is untouched. */
export function setExpanded(e: PanelEntry, expanded?: boolean): PanelEntry {
  const next = expanded ?? !e.expanded;
  if (next === (e.expanded ?? false)) return e;
  if (next) return { ...e, expanded: true };
  const { expanded: _old, ...rest } = e;
  return rest;
}

export interface PanelState {
  byKey: Readonly<Record<string, PanelEntry>>;
}

/**
 * Focus requests for the panel go through the ui store (panelFocusSeq), which the palette
 * also uses. Persisted whole: open state, tabs, active tab and width survive a reload.
 */
export const usePanelStore = create<PanelState>()(
  persist(() => ({ byKey: {} }), {
    name: "code-foundry.panel",
    version: 1,
    partialize: (s) => ({ byKey: s.byKey }),
  }),
);

/** A panel key (keyOf), or "current" for the window's selection. */
export type PanelTarget = string;

function resolve(target: PanelTarget): string | null {
  return target === "current" ? keyOf(useUiStore.getState().selection) : target;
}

/**
 * Applies a reducer to one key's entry. Returns the key it changed, or null. With
 * `focus`, an open result asks the panel to take focus. That request comes after the
 * state change, so the panel it shows is mounted when SidePanel acts on it.
 */
function update(target: PanelTarget, f: (e: PanelEntry) => PanelEntry, opts?: { focus?: boolean }): string | null {
  const key = resolve(target);
  if (key === null) return null;
  usePanelStore.setState((s) => {
    const prev = s.byKey[key] ?? emptyEntry;
    const next = f(prev);
    return next === prev ? s : { byKey: { ...s.byKey, [key]: next } };
  });
  if (opts?.focus && (usePanelStore.getState().byKey[key]?.open ?? false)) {
    useUiStore.setState((s) => ({ panelFocusSeq: s.panelFocusSeq + 1 }));
  }
  return key;
}

/** The entry for a key (or the current selection); a fresh closed one if it has none. */
export function getPanel(target: PanelTarget = "current"): PanelEntry {
  const key = resolve(target);
  return key === null ? emptyEntry : (usePanelStore.getState().byKey[key] ?? emptyEntry);
}

/**
 * Programmatic open for surfaces: opens the panel for the selection key ("current" for
 * the window's selection), adds or activates the tab, and makes the panel visible.
 * Returns false when there is no panel to open (nothing selected).
 */
export function openSurface(target: PanelTarget, tab: Tab): boolean {
  return update(target, (e) => openTab(e, tab)) !== null;
}

/**
 * Shows or hides the panel for a key (default: the current selection). Showing it asks
 * the panel to take focus so its hotkeys work at once, unless `focus` is false. Returns
 * the new open state. The view.panel.toggle command is togglePanelCommand (stores/views.ts).
 */
export function togglePanel(target: PanelTarget = "current", open?: boolean, opts: { focus?: boolean } = {}): boolean {
  const key = update(target, (e) => toggle(e, open), { focus: opts.focus ?? true });
  return key !== null && (usePanelStore.getState().byKey[key]?.open ?? false);
}

export function closePanelTab(target: PanelTarget, id: string): void {
  update(target, (e) => closeTab(e, id));
}

export function activatePanelTab(target: PanelTarget, id: string): void {
  update(target, (e) => activateTab(e, id));
}

/**
 * Expands a panel to the full width of the content area, restores its split (`expanded`
 * false), or flips it. Expanding shows a hidden panel. With `focus`, an expanded result
 * asks the panel to take focus. Returns whether the panel is now open and expanded. The
 * view.panel.expand command is expandPanelCommand (stores/views.ts).
 */
export function expandPanel(target: PanelTarget = "current", expanded?: boolean, opts: { focus?: boolean } = {}): boolean {
  const key = update(target, (e) => {
    const next = setExpanded(e, expanded);
    return next.expanded ? toggle(next, true) : next;
  });
  if (key === null) return false;
  const result = usePanelStore.getState().byKey[key]?.expanded ?? false;
  // After the state change, so the panel it shows is mounted when SidePanel acts on it.
  if (result && opts.focus) useUiStore.setState((s) => ({ panelFocusSeq: s.panelFocusSeq + 1 }));
  return result;
}

/** Sets one panel's width, clamped to [PANEL_MIN, panelMax] for the current window and sidebar. */
export function setPanelWidth(target: PanelTarget, w: number): void {
  const ui = useUiStore.getState();
  const width = clampPanelWidth(w, ui.windowWidth, visibleSidebarWidth(ui));
  update(target, (e) => setWidth(e, width));
}

/** Puts one panel back at PANEL_DEFAULT (drops its stored width). */
export function resetPanelWidth(target: PanelTarget): void {
  update(target, (e) => setWidth(e, undefined));
}

/** The current selection's panel key (a string, so the selector is cheap and stable). */
export function useCurrentPanelKey(): string | null {
  return useUiStore((s) => keyOf(s.selection));
}

/** A panel's stored width (PANEL_DEFAULT when it has none); not yet bounded by panelMax. */
export function usePanelWidth(key: string): number {
  return usePanelStore((s) => s.byKey[key]?.width ?? PANEL_DEFAULT);
}

/** Whether the current selection's panel is open and expanded (it then fills the content area). */
export function usePanelExpanded(): boolean {
  const key = useCurrentPanelKey();
  return usePanelStore((s) => {
    const e = key === null ? undefined : s.byKey[key];
    return (e?.open ?? false) && (e?.expanded ?? false);
  });
}

/** Whether the current selection's panel is open. */
export function usePanelOpen(): boolean {
  const key = useCurrentPanelKey();
  return usePanelStore((s) => (key === null ? false : (s.byKey[key]?.open ?? false)));
}
