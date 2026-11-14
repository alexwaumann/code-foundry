/**
 * The host seam: how a surface (a file, a diff, a pull request, MCP, a plugin's view, Ember's
 * board) and the code around it reach the tabs it lives in, without knowing what draws them. Each
 * operation goes to the daemon's layout (shell/hostShell.ts, docs/notes/shell-11-pane-grid.md).
 * The classic side panel it once also delegated to is gone (docs/notes/shell-21-remove-classic.md);
 * the seam stays so surfaces name places, not panes. See docs/notes/shell-8-host-seam.md.
 *
 * A target names where tabs go: "current" (what the window shows), `thread:<id>` (a thread's
 * linked tabs), `pane:<id>` (one pane's), or another key `targetOf` gives for a selection (a
 * page's, the composer's: the current space's unlinked tabs).
 */
import { useUiStore, type Selection } from "@/stores/ui";
import { useLayoutStore } from "@/stores/layout";
import {
  EMPTY_PLACE,
  findShellTab,
  shellActivateTab,
  shellOpenTab,
  shellPlace,
  shellPlaces,
  shellReplaceTab,
  shellRetitleTab,
  shellSetTabParams,
  threadOfShellTarget,
} from "./hostShell";
import { seamTab } from "./kinds";
import { makeTab, pullRequestTabId, selectionTarget, tabId, type SurfaceKind, type Tab } from "./tabs";

export type { SurfaceKind, Tab };
export { makeTab, pullRequestTabId, tabId };

/** Where tabs go: "current", `thread:<id>`, `pane:<id>`, or a key from targetOf. */
export type TabTarget = string;

/** The target of a selection's tabs; null for `none` (it has no tabs of its own). */
export function targetOf(sel: Selection): TabTarget | null {
  return selectionTarget(sel);
}

/** A thread's target. */
export function threadTarget(threadId: string): TabTarget {
  return `thread:${threadId}`;
}

/** The thread a target's tabs belong to ("current" resolved); "" for any other target. */
export function threadOfTarget(target: TabTarget): string {
  return threadOfShellTarget(target);
}

/** The target of what the window shows (a string, so the selector is cheap and stable). */
export function useCurrentTarget(): TabTarget | null {
  return useUiStore((s) => selectionTarget(s.selection));
}

/** One group of tabs (a pane holding some of the target's tabs) and the one it shows. */
export interface TabPlaceGroup {
  readonly tabs: readonly Tab[];
  readonly active: Tab | null;
}

/**
 * The tabs under one target, as surfaces read them. The same object until that target's tabs
 * change, so a selector may return it or a part of it.
 */
export interface TabPlace {
  /** Whether the target has tabs in the layout. */
  readonly shown: boolean;
  /** Every tab, in layout order, pane by pane. */
  readonly tabs: readonly Tab[];
  /** One per pane holding the target's tabs (one empty group when there are none). */
  readonly groups: readonly TabPlaceGroup[];
  /** The index in `groups` of the focused pane's group: where keys go. */
  readonly focused: number;
}

/** Every target that has tabs, to its place. */
export type TabPlaces = Readonly<Record<TabTarget, TabPlace>>;

/** A target's tabs now (default: what the window shows); an empty place when it has none. */
export function tabPlace(target: TabTarget = "current"): TabPlace {
  return shellPlace(useLayoutStore.getState(), target);
}

/** A target's tab with this id (a layout id, or a seam id: the open tab of the identity it names), if it holds one. */
export function findTab(target: TabTarget, id: string): Tab | undefined {
  const t = findShellTab(useLayoutStore.getState(), target, id);
  return t ? seamTab(t) : undefined;
}

/** The tab a place's focused group shows: what keys act on. Null while it shows none. */
export function shownTab(place: TabPlace): Tab | null {
  return place.groups[place.focused]?.active ?? null;
}

/** The index of the group holding a tab; null when the place does not hold it. */
export function groupOfTab(place: TabPlace, id: string): number | null {
  const g = place.groups.findIndex((x) => x.tabs.some((t) => t.id === id));
  return g < 0 ? null : g;
}

/**
 * Selects from a target's place, re-rendering only when the selection changes. Return a
 * primitive or a part of the place (it keeps its identity). `target` is a resolved target
 * (useCurrentTarget), not "current"; null selects from an empty place.
 */
export function useTabPlace<T>(target: TabTarget | null, select: (place: TabPlace) => T): T {
  return useLayoutStore((s) => select(target === null ? EMPTY_PLACE : shellPlace(s, target)));
}

/**
 * Calls `listener` after any target's tabs change (opened, closed, moved, retitled), with every
 * place now and before. Returns the unsubscribe.
 */
export function subscribeTabs(listener: (now: TabPlaces, prev: TabPlaces) => void): () => void {
  return useLayoutStore.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs || s.panes !== prev.panes || s.trees !== prev.trees || s.spaces !== prev.spaces) listener(shellPlaces(s), shellPlaces(prev));
  });
}

/** For a SurfaceSpec's `watches`: notified whenever any tabs change. */
export const tabChanges = {
  subscribe: (listener: () => void): (() => void) => useLayoutStore.subscribe(listener),
};

/**
 * Opens a tab, or activates the open one of its identity where it is (its title and params
 * refreshed): the same kind, link and key params (shell/identity.ts), whatever else its params
 * hold. A new tab goes to the target's `group` (its pane), else where the daemon places it. The
 * user asked for it: it is shown and takes the focus and the keyboard. `focus: false` is a
 * thread's call (a view.open.* ShowView), which never moves the user's focus. `behind` names a tab
 * the user is typing in: nothing takes the focus then, an open tab only takes the new params, and a
 * new one waits behind that tab if it lands in its pane, so nothing moves under someone typing.
 * False before the layout has loaded.
 */
export function openTab(target: TabTarget, tab: Tab, opts: { group?: number; behind?: string; focus?: boolean } = {}): boolean {
  return shellOpenTab(target, tab, { ...opts, focus: opts.focus ?? true });
}

/** Activates a tab where it is, focusing its pane; an unknown id changes nothing. */
export function activateTab(target: TabTarget, id: string): void {
  shellActivateTab(target, id);
}

/** Renames a tab; an unknown id, an empty or the same title changes nothing. */
export function retitleTab(target: TabTarget, id: string, title: string): void {
  shellRetitleTab(target, id, title);
}

/**
 * Sets a tab's params where it is (`params`, or a function of the old ones): nothing
 * activates, opens or takes focus. An unknown id or the same params change nothing.
 */
export function setTabParams(target: TabTarget, id: string, params: Tab["params"] | ((old: Tab["params"]) => Tab["params"])): void {
  shellSetTabParams(target, id, params);
}

/** Puts `tab` where tab `id` is (a tab that became another file); if `tab` is already open, `id` just closes. */
export function replaceTab(target: TabTarget, id: string, tab: Tab): void {
  shellReplaceTab(target, id, tab);
}
