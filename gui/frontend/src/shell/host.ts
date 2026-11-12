/**
 * The host seam: how a surface (a file, a diff, a pull request, MCP, a plugin's view, Ember's
 * board) and the code around it reach the tabs it lives in, without knowing what draws them.
 * With the classic window every operation delegates to the side panel (stores/panel.ts); while
 * the window shell draws the window (docs/notes/shell-model.md, the shell flag) each goes to the
 * daemon's layout instead (shell/hostShell.ts, docs/notes/shell-11-pane-grid.md), and the callers
 * stay as they are. Only the side panel's own code (components/panel, the bottom panel, the
 * panel's commands) imports stores/panel.ts; host.guard.test.ts keeps it that way.
 * See docs/notes/shell-8-host-seam.md.
 *
 * A target names where tabs go: "current" (what the window shows), `thread:<id>` (a thread's
 * tabs), or another key `targetOf` gives for a selection (a page's, the composer's). Classic
 * targets are the side panel's keys.
 */
import {
  activatePanelTab,
  allTabs,
  expandPanel,
  focusedGroup,
  getPanel,
  keyOf,
  makeTab,
  openSurface,
  panelThreadId,
  pullRequestTabId,
  replacePanelTab,
  retitlePanelTab,
  setPanelTabParams,
  tabId,
  togglePanel,
  useCurrentPanelKey,
  usePanelStore,
  type GroupIndex,
  type PanelEntry,
  type SurfaceKind,
  type Tab,
} from "@/stores/panel";
import type { Selection } from "@/stores/ui";
import { useLayoutStore } from "@/stores/layout";
import { shellDrawn, useShellViewStore } from "@/stores/shellView";
import {
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

export type { SurfaceKind, Tab };
export { makeTab, pullRequestTabId, tabId };

/** Where tabs go: "current", `thread:<id>`, a key from targetOf, or in the shell `pane:<id>`. */
export type TabTarget = string;

/** One group of a place's tabs (a group of the split side panel): the group a surface's own picker opens into. */
export type TabGroup = GroupIndex;

/** The target of a selection's tabs; null for `none` (it has no tabs of its own). */
export function targetOf(sel: Selection): TabTarget | null {
  return keyOf(sel);
}

/** A thread's target. */
export function threadTarget(threadId: string): TabTarget {
  return `thread:${threadId}`;
}

/** The thread a target's tabs belong to ("current" resolved); "" for any other target. */
export function threadOfTarget(target: TabTarget): string {
  return shellDrawn() ? threadOfShellTarget(target) : panelThreadId(target);
}

/** The target of what the window shows (a string, so the selector is cheap and stable). */
export function useCurrentTarget(): TabTarget | null {
  return useCurrentPanelKey();
}

/** One group of tabs and the one it shows (null while it shows none: the side panel's picker). */
export interface TabPlaceGroup {
  readonly tabs: readonly Tab[];
  readonly active: Tab | null;
}

/**
 * The tabs under one target, as surfaces read them. The same object until that target's tabs
 * change, so a selector may return it or a part of it.
 */
export interface TabPlace {
  /** Whether the tabs are on screen (the side panel is open). */
  readonly shown: boolean;
  /** Whether they fill the content area (the side panel is expanded). */
  readonly expanded: boolean;
  /** Every tab, in strip order, the first group's then the second's. */
  readonly tabs: readonly Tab[];
  /** One or two groups. */
  readonly groups: readonly TabPlaceGroup[];
  /** The index in `groups` of the group the user last worked in: where keys go and new tabs open. */
  readonly focused: number;
}

/** Every target that has tabs, to its place. The same object until any of them changes. */
export type TabPlaces = Readonly<Record<TabTarget, TabPlace>>;

const EMPTY_PLACE: TabPlace = placeFrom({ open: false, groups: [{ tabs: [], activeTabId: null }] });

function placeFrom(e: PanelEntry): TabPlace {
  return {
    shown: e.open,
    expanded: e.expanded ?? false,
    tabs: allTabs(e),
    groups: e.groups.map((g) => ({ tabs: g.tabs, active: g.tabs.find((t) => t.id === g.activeTabId) ?? null })),
    focused: focusedGroup(e),
  };
}

const places = new WeakMap<PanelEntry, TabPlace>();

/** An entry's place, made once per entry object, so selectors stay narrow. */
function placeOf(e: PanelEntry | undefined): TabPlace {
  if (e === undefined) return EMPTY_PLACE;
  let p = places.get(e);
  if (p === undefined) {
    p = placeFrom(e);
    places.set(e, p);
  }
  return p;
}

const placeSets = new WeakMap<Readonly<Record<string, PanelEntry>>, TabPlaces>();

function placesOf(byKey: Readonly<Record<string, PanelEntry>>): TabPlaces {
  let p = placeSets.get(byKey);
  if (p === undefined) {
    p = Object.fromEntries(Object.entries(byKey).map(([k, e]) => [k, placeOf(e)]));
    placeSets.set(byKey, p);
  }
  return p;
}

/** A target's tabs now (default: what the window shows); an empty, hidden place when it has none. */
export function tabPlace(target: TabTarget = "current"): TabPlace {
  return shellDrawn() ? shellPlace(useLayoutStore.getState(), target) : placeOf(getPanel(target));
}

/** A target's tab with this id, if it holds one. */
export function findTab(target: TabTarget, id: string): Tab | undefined {
  if (shellDrawn()) {
    const t = findShellTab(useLayoutStore.getState(), target, id);
    return t ? seamTab(t) : undefined;
  }
  return tabPlace(target).tabs.find((t) => t.id === id);
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
  const shell = useShellViewStore((s) => s.mode === "shell");
  const classic = usePanelStore((s) => (shell ? null : select(placeOf(target === null ? undefined : s.byKey[target]))));
  const inShell = useLayoutStore((s) => (shell ? select(target === null ? placeOf(undefined) : shellPlace(s, target)) : null));
  return (shell ? inShell : classic) as T;
}

/**
 * Calls `listener` after any target's tabs change (opened, closed, moved, shown, retitled),
 * with every place now and before. Returns the unsubscribe.
 */
export function subscribeTabs(listener: (now: TabPlaces, prev: TabPlaces) => void): () => void {
  const a = usePanelStore.subscribe((s, prev) => {
    if (!shellDrawn() && s.byKey !== prev.byKey) listener(placesOf(s.byKey), placesOf(prev.byKey));
  });
  const b = useLayoutStore.subscribe((s, prev) => {
    if (shellDrawn() && (s.tabs !== prev.tabs || s.panes !== prev.panes || s.trees !== prev.trees || s.spaces !== prev.spaces)) listener(shellPlaces(s), shellPlaces(prev));
  });
  return () => {
    a();
    b();
  };
}

/** For a SurfaceSpec's `watches`: notified whenever any tabs change. */
export const tabChanges = {
  subscribe: (listener: () => void): (() => void) => {
    const a = usePanelStore.subscribe(listener);
    const b = useLayoutStore.subscribe(listener);
    return () => {
      a();
      b();
    };
  },
};

/**
 * Opens a tab, or activates the one with its id where it is (its title and params refreshed),
 * and shows the target's tabs. A new tab goes to `group` (default: the focused one). `behind`:
 * a new tab joins the strip behind the one showing, and an open one only takes the new params,
 * so nothing moves under someone typing. It does not take focus. False when there is no
 * target (nothing selected).
 */
export function openTab(target: TabTarget, tab: Tab, opts: { group?: TabGroup; behind?: boolean } = {}): boolean {
  if (shellDrawn()) return shellOpenTab(target, tab, opts);
  return openSurface(target, tab, opts);
}

/** Activates a tab where it is, focusing its group; an unknown id changes nothing. */
export function activateTab(target: TabTarget, id: string): void {
  if (shellDrawn()) shellActivateTab(target, id);
  else activatePanelTab(target, id);
}

/** Renames a tab; an unknown id, an empty or the same title changes nothing. */
export function retitleTab(target: TabTarget, id: string, title: string): void {
  if (shellDrawn()) shellRetitleTab(target, id, title);
  else retitlePanelTab(target, id, title);
}

/**
 * Sets a tab's params where it is (`params`, or a function of the old ones): nothing
 * activates, opens or takes focus. An unknown id or the same params change nothing.
 */
export function setTabParams(target: TabTarget, id: string, params: Tab["params"] | ((old: Tab["params"]) => Tab["params"])): void {
  if (shellDrawn()) {
    shellSetTabParams(target, id, params);
    return;
  }
  if (typeof params !== "function") {
    setPanelTabParams(target, id, params);
    return;
  }
  const old = findTab(target, id);
  if (old) setPanelTabParams(target, id, params(old.params));
}

/** Puts `tab` where tab `id` is, active if that one was (a tab that became another file); if `tab` is already open, `id` just closes. */
export function replaceTab(target: TabTarget, id: string, tab: Tab): void {
  if (shellDrawn()) shellReplaceTab(target, id, tab);
  else replacePanelTab(target, id, tab);
}

/**
 * Shows or hides a target's tabs (the side panel). Showing asks for focus unless `focus` is
 * false. Returns whether they are shown now.
 */
export function showTabs(target: TabTarget, shown: boolean, opts: { focus?: boolean } = {}): boolean {
  // In the shell a tab is always in a pane: there is nothing to show or hide.
  if (shellDrawn()) return shown && tabPlace(target).tabs.length > 0;
  return togglePanel(target, shown, opts);
}

/** Makes a target's tabs fill the content area (expands the side panel). Returns whether they do. */
export function expandTabs(target: TabTarget, opts: { focus?: boolean } = {}): boolean {
  // Full screen (the shell's expand) is PR 19's.
  if (shellDrawn()) return false;
  return expandPanel(target, true, opts);
}
