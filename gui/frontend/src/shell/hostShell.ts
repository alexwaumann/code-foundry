/**
 * The shell half of the host seam (shell/host.ts): the same tab operations over the daemon's
 * layout (stores/layout.ts), used while the window shell draws the window. Surfaces keep calling
 * host.ts; what changes is where their tabs are.
 *
 * Targets, as the seam names them:
 * - `thread:<id>`: that thread's linked tabs in its space; the panes holding them are the groups.
 * - `pane:<id>`: one pane's tabs.
 * - `current`: the target of the selection (the selection bridge writes it from the focused tab).
 * - any other key (a page's, the composer's): the unlinked tabs of the current space.
 *
 * Tab ids are the layout's (`t-…`): a surface's body gets its layout tab (shell/surfaces/panel.ts),
 * and an id lookup searches every space, so the target of an id-based call does not matter. A seam
 * id a surface made itself (makeTab: kind and params) also finds the open tab it stands for.
 * Opening goes through the daemon (open_surface), which deduplicates by identity and places the
 * tab; nothing here changes the slice before the daemon answers.
 * See docs/notes/shell-11-pane-grid.md.
 */
import { applyLayoutOp, type LayoutOpView } from "@/api/layout";
import { focusTab as focusTabOp, useLayoutStore, type LayoutState, type TabEntry } from "@/stores/layout";
import { keyOf, tabId, type Tab } from "@/stores/panel";
import { useUiStore } from "@/stores/ui";
import { layoutKindOf, panelKindOf, seamTab } from "./kinds";
import type { TabPlace, TabPlaceGroup, TabPlaces, TabTarget } from "./host";

/** Kinds that are pages or the composer, not a surface the side panel had: never in a place. */
const NOT_PANEL = new Set(["thread", "prs", "projects", "compose", "terminal"]);

/** A target with "current" resolved to the selection's. */
export function resolveTarget(target: TabTarget): TabTarget {
  if (target !== "current") return target;
  return keyOf(useUiStore.getState().selection) ?? "";
}

/** The thread a resolved target belongs to; "" for any other. */
export function threadOfShellTarget(target: TabTarget): string {
  const t = resolveTarget(target);
  return t.startsWith("thread:") ? t.slice(7) : "";
}

/** The panes of a space in layout order. */
function panesInOrder(s: LayoutState, spaceId: string): string[] {
  const out: string[] = [];
  const walk = (n: (typeof s.trees)[string]): void => {
    if (!n) return;
    if (n.t === "pane") out.push(n.id);
    else n.kids.forEach(walk);
  };
  walk(s.trees[spaceId] ?? null);
  return out;
}

/** The space a thread lives in. */
function spaceOf(s: LayoutState, threadId: string): string {
  return s.threads[threadId]?.spaceId ?? s.defaultSpaceId;
}

/** The tabs under a target, as pane groups in layout order. */
function groupsOf(s: LayoutState, target: TabTarget): { paneId: string; tabs: TabEntry[] }[] {
  const t = resolveTarget(target);
  let spaceId = s.currentSpaceId;
  let keep: (tab: TabEntry) => boolean;
  if (t.startsWith("pane:")) {
    const pane = s.panes[t.slice(5)];
    if (!pane) return [];
    return [{ paneId: pane.id, tabs: pane.tabIds.flatMap((id) => s.tabs[id] ?? []) }];
  }
  if (t.startsWith("thread:")) {
    const thread = t.slice(7);
    spaceId = spaceOf(s, thread);
    keep = (tab) => tab.thread === thread && tab.kind !== "thread";
  } else {
    keep = (tab) => !tab.thread && !NOT_PANEL.has(tab.kind);
  }
  return panesInOrder(s, spaceId).flatMap((paneId) => {
    const tabs = (s.panes[paneId]?.tabIds ?? []).flatMap((id) => s.tabs[id] ?? []).filter(keep);
    return tabs.length > 0 ? [{ paneId, tabs }] : [];
  });
}

const EMPTY: TabPlace = { shown: false, expanded: false, tabs: [], groups: [{ tabs: [], active: null }], focused: 0 };

/** The last place made per target, kept while it reads the same, so selectors stay narrow. */
const lastPlaces = new Map<TabTarget, { sig: string; place: TabPlace }>();

function signature(groups: { paneId: string; tabs: TabEntry[] }[], active: (string | null)[], focused: number): string {
  return JSON.stringify([groups.map((g) => [g.paneId, g.tabs.map((t) => [t.id, t.kind, t.title, t.name, t.params])]), active, focused]);
}

/** A target's tabs in the layout now. */
export function shellPlace(s: LayoutState, target: TabTarget): TabPlace {
  const t = resolveTarget(target);
  const groups = groupsOf(s, t);
  if (groups.length === 0) return EMPTY;
  const actives = groups.map((g) => {
    const a = s.panes[g.paneId]?.active ?? "";
    return g.tabs.some((x) => x.id === a) ? a : null;
  });
  const focusPane = s.spaces[s.panes[groups[0]?.paneId ?? ""]?.spaceId ?? ""]?.focus ?? "";
  const focused = Math.max(0, groups.findIndex((g) => g.paneId === focusPane));
  const sig = signature(groups, actives, focused);
  const last = lastPlaces.get(t);
  if (last?.sig === sig) return last.place;
  const placeGroups: TabPlaceGroup[] = groups.map((g, i) => {
    const tabs = g.tabs.map((x) => seamTab(x));
    return { tabs, active: tabs.find((x) => x.id === actives[i]) ?? null };
  });
  const place: TabPlace = { shown: true, expanded: false, tabs: placeGroups.flatMap((g) => g.tabs), groups: placeGroups, focused };
  lastPlaces.set(t, { sig, place });
  return place;
}

/** Every target that has tabs: each thread with linked tabs, and each pane. */
export function shellPlaces(s: LayoutState): TabPlaces {
  const out: Record<string, TabPlace> = {};
  const threads = new Set(Object.values(s.tabs).flatMap((t) => (t.thread && t.kind !== "thread" ? [t.thread] : [])));
  for (const id of threads) out[`thread:${id}`] = shellPlace(s, `thread:${id}`);
  for (const id of Object.keys(s.panes)) out[`pane:${id}`] = shellPlace(s, `pane:${id}`);
  return out;
}

/** A layout tab by its id anywhere, or by the seam id (kind and params) a surface made for it. */
export function findShellTab(s: LayoutState, target: TabTarget, id: string): TabEntry | undefined {
  const byId = s.tabs[id];
  if (byId) return byId;
  for (const g of groupsOf(s, target)) {
    const hit = g.tabs.find((t) => tabId(panelKindOf(t.kind), t.params) === id);
    if (hit) return hit;
  }
  return undefined;
}

function apply(op: LayoutOpView): void {
  // A refusal (the tab went meanwhile) changes nothing; the layout stays the daemon's.
  void applyLayoutOp(op).catch(() => undefined);
}

/**
 * Opens a tab through the daemon: linked to the target's thread (placed beside it by the
 * daemon's rules), into a target pane or group's pane when one is named, else the focused pane.
 * An open tab of the same identity is used instead. It does not take the focus.
 */
export function shellOpenTab(target: TabTarget, tab: Tab, opts: { group?: number; behind?: boolean }): boolean {
  const s = useLayoutStore.getState();
  if (!s.loaded) return false;
  const t = resolveTarget(target);
  const open = findShellTab(s, t, tab.id);
  if (open) {
    apply({ op: "set_tab_params", tab: open.id, params: { ...tab.params }, ...(tab.title ? { title: tab.title } : {}) });
    if (!opts.behind) void focusTabOp(open.id);
    return true;
  }
  const pane = t.startsWith("pane:") ? t.slice(5) : opts.group !== undefined ? groupsOf(s, t)[opts.group]?.paneId : undefined;
  const thread = threadOfShellTarget(t);
  apply({
    op: "open_surface",
    tab: { kind: layoutKindOf(tab.kind), ...(thread ? { thread } : {}), params: { ...tab.params }, ...(tab.title ? { title: tab.title } : {}) },
    ...(pane ? { pane } : {}),
    focus: false,
  });
  return true;
}

/** Makes a tab active in its pane (and its pane focused, as the slice's focus does). */
export function shellActivateTab(target: TabTarget, id: string): void {
  const tab = findShellTab(useLayoutStore.getState(), target, id);
  if (tab) void focusTabOp(tab.id);
}

export function shellRetitleTab(target: TabTarget, id: string, title: string): void {
  const tab = findShellTab(useLayoutStore.getState(), target, id);
  if (tab && title && tab.title !== title) apply({ op: "set_tab_params", tab: tab.id, params: { ...tab.params }, title });
}

export function shellSetTabParams(target: TabTarget, id: string, params: Tab["params"] | ((old: Tab["params"]) => Tab["params"])): void {
  const tab = findShellTab(useLayoutStore.getState(), target, id);
  if (!tab) return;
  const next = typeof params === "function" ? params(tab.params) : params;
  if (JSON.stringify(next) === JSON.stringify(tab.params)) return;
  apply({ op: "set_tab_params", tab: tab.id, params: { ...next } });
}

/** Puts `tab` where tab `id` is (a File tab that became another file): its params and title change in place. */
export function shellReplaceTab(target: TabTarget, id: string, tab: Tab): void {
  const s = useLayoutStore.getState();
  const old = findShellTab(s, target, id);
  if (!old) return;
  const open = findShellTab(s, target, tab.id);
  if (open && open.id !== old.id) {
    apply({ op: "close_tab", tab: old.id });
    return;
  }
  apply({ op: "set_tab_params", tab: old.id, params: { ...tab.params }, ...(tab.title ? { title: tab.title } : {}) });
}
