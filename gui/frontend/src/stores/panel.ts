/**
 * The side panel ("surface panel") to the right of the content pane. Each selection
 * (session, terminal, worktree, repo, top-level page) has its own panel: whether it is
 * open, its tabs, and the active tab. Switching selection shows that selection's panel.
 * The width is global and lives in the ui store (persisted); nothing here is persisted.
 * See docs/notes/side-panel.md.
 */
import { create } from "zustand";
import { useUiStore, type Selection } from "./ui";

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
}

export const emptyEntry: PanelEntry = { open: false, tabs: [], activeTabId: null };

/** Panel key for a selection; null for `none`, which has no panel. */
export function keyOf(sel: Selection): string | null {
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
  return { open: true, tabs, activeTabId: tab.id };
}

/**
 * Removes a tab. Closing the active tab activates its right neighbour, else the left one.
 * Closing the last tab hides the panel. An unknown id changes nothing.
 */
export function closeTab(e: PanelEntry, id: string): PanelEntry {
  const i = e.tabs.findIndex((t) => t.id === id);
  if (i < 0) return e;
  const tabs = e.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return { open: false, tabs, activeTabId: null };
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

export interface PanelState {
  byKey: Readonly<Record<string, PanelEntry>>;
}

/** Focus requests for the panel go through the ui store (panelFocusSeq), which the palette also uses. */
export const usePanelStore = create<PanelState>()(() => ({ byKey: {} }));

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

/** The current selection's panel key (a string, so the selector is cheap and stable). */
export function useCurrentPanelKey(): string | null {
  return useUiStore((s) => keyOf(s.selection));
}

/** Whether the current selection's panel is open. */
export function usePanelOpen(): boolean {
  const key = useCurrentPanelKey();
  return usePanelStore((s) => (key === null ? false : (s.byKey[key]?.open ?? false)));
}
