/**
 * The side panel ("surface panel") to the right of the content pane. Each selection
 * (thread, terminal, composer, top-level page) has its own panel: whether it is open,
 * its tab groups, its width, and whether it is expanded to the full width of the content
 * area. A panel has one tab group, or two when split (the split's ratio and the group
 * that has focus are stored with it). Each group has its own tabs and active tab. A
 * group with tabs but no active tab is picking: its "+" was clicked and it shows the
 * surface list until a surface (or a tab) is picked; so is an empty group of a split
 * panel. Switching selection shows that selection's panel. All of it is persisted
 * (localStorage "code-foundry.panel"), so it survives a reload. Entries are never
 * pruned: a deleted thread's panel stays stored.
 * See docs/notes/side-panel.md and docs/notes/panel-split-1-store.md.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { panelKeepOpen } from "./settings";
import { PANEL_DEFAULT, clampPanelWidth, useUiStore, visibleSidebarWidth, type Selection } from "./ui";

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

/** A tab group's index: 0 is the first group (top or left), 1 the second (bottom or right). */
export type GroupIndex = 0 | 1;

/** One tab group: its own strip, active tab and picking state. */
export interface PanelGroup {
  tabs: readonly Tab[];
  activeTabId: string | null;
  /**
   * While picking (tabs but no active tab, see isPicking): the tab that was active when
   * picking began, so leaving picking without a pick goes back to it. Absent otherwise:
   * the reducers drop it rather than store undefined, like `expanded`. Persisted with the
   * rest, so a reload keeps the picker and where it came from.
   */
  pickFrom?: string;
}

export interface PanelEntry {
  open: boolean;
  /**
   * One group, or two when split. A tab id is in at most one of them. A split panel
   * never has an empty group that is not picking: its empty group is picking (the
   * surface list), and leaving that, or a group losing its last tab, collapses the
   * split. An unsplit panel's one group may be empty: the panel then has no tabs and
   * shows the surface list.
   */
  groups: readonly PanelGroup[];
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
  /**
   * The share of the split's axis the first group takes, in [RATIO_MIN, RATIO_MAX].
   * Absent means RATIO_DEFAULT (the reducers drop it when set back). The axis (stacked or
   * side by side) follows the rendered width, and the ratio applies to either. Kept when
   * the split collapses, so the next split comes back at it.
   */
  ratio?: number;
  /**
   * The group the user last interacted with: where tabs opened from outside the panel
   * (commands, links, path chips) go, and what the panel's keys act on. Absent means 0,
   * and it is always absent on an unsplit panel.
   */
  focused?: GroupIndex;
}

export const emptyGroup: PanelGroup = { tabs: [], activeTabId: null };

export const emptyEntry: PanelEntry = { open: false, groups: [emptyGroup] };

export const RATIO_DEFAULT = 0.5;
export const RATIO_MIN = 0.2;
export const RATIO_MAX = 0.8;

/**
 * Panel key for a selection; null for `none` (nothing sets it; App.tsx renders HOME's
 * composer for it, without a panel).
 */
export function keyOf(sel: Selection): string | null {
  switch (sel.kind) {
    case "none":
      return null;
    case "thread":
      return `thread:${sel.id}`;
    // A project's or workspace's page has its own panel beside the Projects index's.
    case "view":
      return sel.projectId ? `view:${sel.name}:project:${sel.projectId}` : sel.workspaceId ? `view:${sel.name}:workspace:${sel.workspaceId}` : `view:${sel.name}`;
    case "compose":
      return sel.workspaceId ? `compose:ws:${sel.workspaceId}` : sel.noProject ? "compose:home:" : `compose:${sel.projectId}`;
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

/** Whether the panel has two groups. */
export function isSplit(e: PanelEntry): boolean {
  return e.groups.length > 1;
}

/** The focused group: `focused`, but 0 on an unsplit panel whatever it says. */
export function focusedGroup(e: PanelEntry): GroupIndex {
  return e.focused === 1 && isSplit(e) ? 1 : 0;
}

/** A group of the panel; the empty group for one it does not have. */
export function groupAt(e: PanelEntry, g: GroupIndex): PanelGroup {
  return e.groups[g] ?? emptyGroup;
}

/** The group holding a tab, or null. */
export function groupOf(e: PanelEntry, id: string): GroupIndex | null {
  const g = e.groups.findIndex((x) => x.tabs.some((t) => t.id === id));
  return g === 0 || g === 1 ? g : null;
}

/** Every tab of the panel: the first group's, then the second's. */
export function allTabs(e: PanelEntry): readonly Tab[] {
  return isSplit(e) ? e.groups.flatMap((g) => g.tabs) : groupAt(e, 0).tabs;
}

/** A group's active tab (default: the focused group's); null while it is picking or empty. */
export function activeTab(e: PanelEntry, g: GroupIndex = focusedGroup(e)): Tab | null {
  const grp = groupAt(e, g);
  return grp.tabs.find((t) => t.id === grp.activeTabId) ?? null;
}

/** A group the panel has: 1 only when it is split. */
function clampGroup(e: PanelEntry, g: GroupIndex): GroupIndex {
  return g === 1 && isSplit(e) ? 1 : 0;
}

/** The group without `pickFrom` (the same group when it has none). */
function dropPickFrom(g: PanelGroup): PanelGroup {
  if (g.pickFrom === undefined) return g;
  const { pickFrom: _old, ...rest } = g;
  return rest;
}

/** The entry without `focused` (the same entry when it has none). */
function dropFocused(e: PanelEntry): PanelEntry {
  if (e.focused === undefined) return e;
  const { focused: _old, ...rest } = e;
  return rest;
}

/** The entry with group `g` replaced (the same entry when it is the same group). */
function withGroup(e: PanelEntry, g: GroupIndex, next: PanelGroup): PanelEntry {
  if (e.groups[g] === next) return e;
  return { ...e, groups: e.groups.map((x, i) => (i === g ? next : x)) };
}

/** The entry with group `g` focused (`focused` dropped for 0); the same entry when it already is. */
function withFocus(e: PanelEntry, g: GroupIndex): PanelEntry {
  if (clampGroup(e, g) === 0) return dropFocused(e);
  return e.focused === 1 ? e : { ...e, focused: 1 };
}

/**
 * Collapses the split by removing group `g` (it emptied, or its picking ended): the
 * other group takes the panel, and focus goes with it (`focused` is dropped).
 */
function collapse(e: PanelEntry, g: GroupIndex): PanelEntry {
  const rest = e.groups.filter((_, i) => i !== g);
  return { ...dropFocused(e), groups: rest.length > 0 ? rest : [emptyGroup] };
}

/**
 * Whether a group (default: the focused one) is picking: it has tabs but none is active,
 * so its body shows the surface list and the "+" after its tabs is highlighted
 * (startPicking). An empty group of a split panel is picking too (a split from a single
 * tab starts its new group that way). An unsplit panel without tabs is not: the list
 * shows anyway, and cmd+w hides the panel there.
 */
export function isPicking(e: PanelEntry, g: GroupIndex = focusedGroup(e)): boolean {
  const grp = e.groups[g];
  if (!grp || grp.activeTabId !== null) return false;
  return grp.tabs.length > 0 || isSplit(e);
}

/** Same keys and values. */
function sameParams(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** openTab within one group: adds or refreshes the tab and makes it active, ending picking. */
function groupOpen(g: PanelGroup, tab: Tab): PanelGroup {
  const i = g.tabs.findIndex((t) => t.id === tab.id);
  const old = i < 0 ? undefined : g.tabs[i];
  const same = old !== undefined && old.title === tab.title && sameParams(old.params, tab.params);
  const tabs = i < 0 ? [...g.tabs, tab] : same ? g.tabs : g.tabs.map((t, j) => (j === i ? { ...t, title: tab.title, params: tab.params } : t));
  return { ...dropPickFrom(g), tabs, activeTabId: tab.id };
}

/**
 * Removes a tab from a group: closing the active tab activates its right neighbour,
 * else the left one; closing the `pickFrom` tab moves `pickFrom` the same way. A group
 * left without tabs is the empty group: what that means for the panel is the caller's.
 */
function groupClose(g: PanelGroup, id: string): PanelGroup {
  const i = g.tabs.findIndex((t) => t.id === id);
  if (i < 0) return g;
  const tabs = g.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return emptyGroup;
  const next = tabs[i] ?? tabs[i - 1] ?? null;
  if (g.pickFrom === id && next) return { ...g, tabs, pickFrom: next.id };
  if (g.activeTabId !== id) return { ...g, tabs };
  return { ...g, tabs, activeTabId: next?.id ?? null };
}

/** Leaves picking in a group with tabs: back to `pickFrom` if it is still there, else the first tab. */
function groupStopPicking(g: PanelGroup): PanelGroup {
  if (g.activeTabId !== null) return g;
  const back = g.tabs.find((t) => t.id === g.pickFrom) ?? g.tabs[0];
  return back ? { ...dropPickFrom(g), activeTabId: back.id } : g;
}

/**
 * Opens the panel with the tab active. An existing tab with the same id is reused in
 * whichever group holds it (its title and params refreshed: a tab whose id leaves out
 * some params, like a File tab's line, takes the new ones), so ids stay unique per
 * panel. A new tab goes to `group` (default: the focused group; 1 on an unsplit panel
 * is 0). Either way the tab's group ends picking and takes focus: this is what picking a
 * surface from a group's list does.
 */
export function openTab(e: PanelEntry, tab: Tab, group?: GroupIndex): PanelEntry {
  const g = groupOf(e, tab.id) ?? clampGroup(e, group ?? focusedGroup(e));
  return withFocus({ ...withGroup(e, g, groupOpen(groupAt(e, g), tab)), open: true }, g);
}

/**
 * Removes a tab from whichever group holds it. Closing the active tab activates its
 * right neighbour, else the left one. While its group is picking, the group keeps
 * picking; closing the tab it would go back to moves `pickFrom` to that tab's right
 * neighbour, else the left one, like closing an active tab. A group losing its last tab
 * collapses the split: the other group takes the panel (and focus). Closing the panel's
 * last tab (no tab left in either group) ends picking and hides the panel, unless
 * `keepOpen` (the appearance.panel_keep_open setting, read by closePanelTab): then the
 * panel keeps its open state and, with no tabs, shows the surface list. An unknown id
 * changes nothing.
 */
export function closeTab(e: PanelEntry, id: string, keepOpen = false): PanelEntry {
  const g = groupOf(e, id);
  if (g === null) return e;
  const next = groupClose(groupAt(e, g), id);
  if (next.tabs.length > 0) return withGroup(e, g, next);
  const rest = collapse(e, g);
  if (allTabs(rest).length > 0) return rest;
  return { ...rest, open: keepOpen && e.open, groups: [emptyGroup] };
}

/** Renames a tab (a plugin view's tab title); an unknown id or the same title changes nothing. */
export function retitleTab(e: PanelEntry, id: string, title: string): PanelEntry {
  const g = groupOf(e, id);
  if (g === null || !title) return e;
  const grp = groupAt(e, g);
  if (grp.tabs.some((t) => t.id === id && t.title === title)) return e;
  return withGroup(e, g, { ...grp, tabs: grp.tabs.map((t) => (t.id === id ? { ...t, title } : t)) });
}

/** Makes an existing tab active in its group (ending picking there), and focuses that group; an unknown id changes nothing. */
export function activateTab(e: PanelEntry, id: string): PanelEntry {
  const g = groupOf(e, id);
  if (g === null) return e;
  const grp = groupAt(e, g);
  const next = grp.activeTabId === id ? grp : { ...dropPickFrom(grp), activeTabId: id };
  return withFocus(withGroup(e, g, next), g);
}

/**
 * Moves a tab to `toIndex` in its group's strip (drag and drop, alt+arrows), with
 * arrayMove semantics: the tab is taken out, then put back at `toIndex`, clamped to the
 * strip. The active tab, picking, focus and everything else are kept. An unknown id, or
 * a move to where the tab already is, returns the same entry. Moving it to the other
 * group is moveTabToGroup.
 */
export function moveTab(e: PanelEntry, id: string, toIndex: number): PanelEntry {
  const g = groupOf(e, id);
  if (g === null || Number.isNaN(toIndex)) return e;
  const grp = groupAt(e, g);
  const from = grp.tabs.findIndex((t) => t.id === id);
  const to = Math.max(0, Math.min(grp.tabs.length - 1, Math.trunc(toIndex)));
  const tab = grp.tabs[from];
  if (to === from || !tab) return e;
  const tabs = grp.tabs.filter((t) => t.id !== id);
  tabs.splice(to, 0, tab);
  return withGroup(e, g, { ...grp, tabs });
}

/**
 * Moves a tab to the other group (a drag onto its strip, or onto an unsplit panel's
 * drop band, which splits the panel) at `toIndex` in that group's strip (clamped;
 * default last). The tab is active there, that group's picking ends, and it takes
 * focus. The source group loses the tab as closeTab would take it; if that leaves the
 * source empty, the split collapses into the target group. Moving the only tab of an
 * unsplit panel, or an unknown id, changes nothing. A target of the tab's own group is
 * moveTab with `toIndex`, and nothing without it.
 */
export function moveTabToGroup(e: PanelEntry, id: string, group: GroupIndex, toIndex?: number): PanelEntry {
  const from = groupOf(e, id);
  if (from === null) return e;
  if (from === group) return toIndex === undefined ? e : moveTab(e, id, toIndex);
  const src = groupAt(e, from);
  const tab = src.tabs.find((t) => t.id === id);
  if (!tab || (!isSplit(e) && src.tabs.length === 1)) return e;
  const dst = groupAt(e, group);
  const at = toIndex === undefined || Number.isNaN(toIndex) ? dst.tabs.length : Math.max(0, Math.min(dst.tabs.length, Math.trunc(toIndex)));
  const tabs = [...dst.tabs];
  tabs.splice(at, 0, tab);
  const left = groupClose(src, id);
  const arrived: PanelGroup = { tabs, activeTabId: id };
  const moved: PanelEntry = { ...e, groups: from === 0 ? [left, arrived] : [arrived, left] };
  return left.tabs.length === 0 ? collapse(moved, from) : withFocus(moved, group);
}

/**
 * Splits the panel into two groups (view.panel.split on an unsplit panel). Picking in
 * its group ends first (back to `pickFrom`). Then the active tab moves into a new second
 * group, which takes focus, and the first group activates that tab's neighbour. With a
 * single tab the tab stays, and the new group starts empty and picking (focused). A
 * panel without tabs, or one already split, comes back unchanged.
 */
export function split(e: PanelEntry): PanelEntry {
  if (isSplit(e)) return e;
  const g0 = groupStopPicking(groupAt(e, 0));
  if (g0.activeTabId === null) return e;
  if (g0.tabs.length === 1) return { ...e, groups: [g0, emptyGroup], focused: 1 };
  return moveTabToGroup({ ...e, groups: [g0] }, g0.activeTabId, 1);
}

/**
 * Joins a split panel's groups (view.panel.split on a split panel): the second group's
 * tabs follow the first's in one strip, and the focused group's active tab stays active
 * (its `pickFrom` while it is picking; the other group's when it has neither, as an
 * empty group). Picking ends. Width, expanded and the ratio are kept. An unsplit panel
 * comes back unchanged.
 */
export function unsplit(e: PanelEntry): PanelEntry {
  if (!isSplit(e)) return e;
  const f = focusedGroup(e);
  const mine = groupAt(e, f);
  const other = groupAt(e, f === 0 ? 1 : 0);
  const tabs = allTabs(e);
  const keep = [mine.activeTabId, mine.pickFrom, other.activeTabId, other.pickFrom].find((id) => id != null && tabs.some((t) => t.id === id));
  return { ...dropFocused(e), groups: [{ tabs, activeTabId: keep ?? tabs[0]?.id ?? null }] };
}

/**
 * Starts picking in a group (its "+", view.panel.new-tab; default: the focused group):
 * no tab is active, so the body shows the surface list, and `pickFrom` remembers the tab
 * that was. The group takes focus. No tab is added until a surface is picked (openTab).
 * A group without tabs already shows the list, and one already picking stays as it is.
 */
export function startPicking(e: PanelEntry, group: GroupIndex = focusedGroup(e)): PanelEntry {
  const g = clampGroup(e, group);
  const grp = groupAt(e, g);
  const next = grp.tabs.length === 0 || grp.activeTabId === null ? grp : { ...grp, activeTabId: null, pickFrom: grp.activeTabId };
  return withFocus(withGroup(e, g, next), g);
}

/**
 * Leaves picking in a group without a pick (Escape, cmd+w; default: the focused group):
 * back to `pickFrom` if that tab is still there, else the first tab, and the group takes
 * focus. An empty group of a split panel has nothing to go back to: the split collapses,
 * and focus goes to the remaining group. Not picking changes nothing.
 */
export function stopPicking(e: PanelEntry, group: GroupIndex = focusedGroup(e)): PanelEntry {
  const g = clampGroup(e, group);
  if (!isPicking(e, g)) return e;
  const grp = groupAt(e, g);
  if (grp.tabs.length === 0) return collapse(e, g);
  return withFocus(withGroup(e, g, groupStopPicking(grp)), g);
}

/** Focuses a group (the user interacted with it); 1 on an unsplit panel changes nothing. */
export function focusGroup(e: PanelEntry, group: GroupIndex): PanelEntry {
  return withFocus(e, group);
}

/**
 * Sets the split's ratio, clamped to [RATIO_MIN, RATIO_MAX]; RATIO_DEFAULT (or
 * undefined) drops it. NaN changes nothing. The panel need not be split: the ratio waits
 * for the next split.
 */
export function setRatio(e: PanelEntry, ratio: number | undefined): PanelEntry {
  if (ratio !== undefined && Number.isNaN(ratio)) return e;
  const next = ratio === undefined ? RATIO_DEFAULT : Math.max(RATIO_MIN, Math.min(RATIO_MAX, ratio));
  if (next === (e.ratio ?? RATIO_DEFAULT)) return e;
  if (next !== RATIO_DEFAULT) return { ...e, ratio: next };
  const { ratio: _old, ...rest } = e;
  return rest;
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

/** A stored entry of versions 1 and 2: one flat tab list. */
export interface PanelEntryV2 {
  open: boolean;
  tabs: readonly Tab[];
  activeTabId: string | null;
  pickFrom?: string;
  width?: number;
  expanded?: boolean;
}

/**
 * Version 1 to 2: a tab param `repo` (a worktree tab's project id, before the rename of
 * repo to project) is `project`, and the ids derived from it follow.
 */
export function migratePanelV1(byKey: Readonly<Record<string, PanelEntryV2>>): Record<string, PanelEntryV2> {
  const out: Record<string, PanelEntryV2> = {};
  for (const [key, e] of Object.entries(byKey)) {
    const ids = new Map<string, string>();
    const tabs = e.tabs.map((t) => {
      if (!("repo" in t.params)) return t;
      const { repo, ...rest } = t.params;
      const next = makeTab(t.kind, t.title, { ...rest, project: repo });
      ids.set(t.id, next.id);
      return next;
    });
    const moved = (id: string) => ids.get(id) ?? id;
    out[key] = {
      ...e,
      tabs,
      activeTabId: e.activeTabId === null ? null : moved(e.activeTabId),
      ...(e.pickFrom === undefined ? {} : { pickFrom: moved(e.pickFrom) }),
    };
  }
  return out;
}

/**
 * Version 2 to 3: the flat tab list (`tabs`, `activeTabId`, `pickFrom`) becomes the
 * panel's one group. Everything else (open, width, expanded) is kept as it was; there is
 * no split, ratio or focus to carry over.
 */
export function migratePanelV2(byKey: Readonly<Record<string, PanelEntryV2>>): Record<string, PanelEntry> {
  const out: Record<string, PanelEntry> = {};
  for (const [key, e] of Object.entries(byKey)) {
    const { tabs, activeTabId, pickFrom, ...rest } = e;
    out[key] = { ...rest, groups: [{ tabs, activeTabId, ...(pickFrom === undefined ? {} : { pickFrom }) }] };
  }
  return out;
}

/** Surfaces the thread info card replaced (docs/notes/thread-header-crumb.md): their stored tabs are dropped. */
const REMOVED_KINDS: ReadonlySet<string> = new Set(["usage", "linkedprs", "threads", "agents"]);

/**
 * A version 3 tab as version 4 keeps it: a Worktree tab of a worktree is that worktree's
 * Changes tab (the same { project, path }, titled "Changes · <its old title>"); a Worktree
 * tab of a workspace's folder, and a tab of a removed surface, is dropped (null).
 */
function tabV4(t: Tab): Tab | null {
  if (REMOVED_KINDS.has(t.kind)) return null;
  if (t.kind !== "worktree") return t;
  const { project, path } = t.params;
  return project && path ? makeTab("changes", `Changes · ${t.title}`, { project, path }) : null;
}

/**
 * Version 3 to 4: the side panel's Worktree, Usage, Linked PRs, Threads and Agents
 * surfaces are gone (tabV4). A group's active tab and pickFrom follow their tab's new id;
 * a group whose active tab went shows its first tab left; a split whose group emptied is
 * one group again. Input repaired by sanitizePanelState first.
 */
export function migratePanelV3(byKey: Readonly<Record<string, PanelEntry>>): Record<string, PanelEntry> {
  const out: Record<string, PanelEntry> = {};
  for (const [key, e] of Object.entries(byKey)) {
    const groups = e.groups.map((g): PanelGroup => {
      const ids = new Map<string, string>();
      const tabs: Tab[] = [];
      for (const t of g.tabs) {
        const next = tabV4(t);
        if (!next) continue;
        ids.set(t.id, next.id);
        tabs.push(next);
      }
      const pickFrom = g.pickFrom === undefined ? undefined : ids.get(g.pickFrom);
      const active = g.activeTabId === null ? null : (ids.get(g.activeTabId) ?? null);
      // Picking with its tab still there stays picking; anything else shows a tab when there is one.
      if (g.activeTabId === null && pickFrom !== undefined) return { tabs, activeTabId: null, pickFrom };
      return { tabs, activeTabId: active ?? tabs[0]?.id ?? null };
    });
    const kept = groups.filter((g) => g.tabs.length > 0);
    const { focused: _focused, ratio: _ratio, ...rest } = e;
    if (groups.length > 1 && kept.length < 2) {
      out[key] = { ...rest, groups: [kept[0] ?? emptyGroup] };
    } else {
      out[key] = { ...e, groups };
    }
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored tab with every field the surface registry needs; anything else is dropped. */
function sanitizeTab(v: unknown): Tab | null {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.kind !== "string" || typeof v.title !== "string" || !isRecord(v.params)) return null;
  const params: Record<string, string> = {};
  for (const [k, x] of Object.entries(v.params)) if (typeof x === "string") params[k] = x;
  return { id: v.id, kind: v.kind, title: v.title, params };
}

function sanitizeGroup(v: unknown): PanelGroup {
  if (!isRecord(v)) return emptyGroup;
  const tabs = Array.isArray(v.tabs) ? v.tabs.map(sanitizeTab).filter((t): t is Tab => t !== null) : [];
  const has = (id: unknown): id is string => typeof id === "string" && tabs.some((t) => t.id === id);
  const activeTabId = has(v.activeTabId) ? v.activeTabId : null;
  // Picking (tabs, no active tab) is only meaningful with a tab to come back to.
  return { tabs, activeTabId, ...(activeTabId === null && has(v.pickFrom) ? { pickFrom: v.pickFrom } : {}) };
}

/**
 * Repairs a stored `byKey` of any shape into entries the reducers and selectors can
 * trust: groups with a tabs array (one or two), an active tab that exists, numbers where
 * numbers go. The persisted store is shared by every build that runs on this machine
 * (the same WebKit localStorage), and an older build reading a newer store writes it
 * back in its own shape: version 2 entries that still carry `groups`, then version 3
 * entries whose groups are `{}`. Before this, one such entry threw in a selector
 * (`groups[0].tabs.length`) and the whole app unmounted to a black window
 * (docs/notes/html-preview-interactive.md). Runs on every rehydrate (persist `merge`),
 * after any migration.
 */
export function sanitizePanelState(byKey: unknown): Record<string, PanelEntry> {
  const out: Record<string, PanelEntry> = {};
  if (!isRecord(byKey)) return out;
  for (const [key, v] of Object.entries(byKey)) {
    if (!isRecord(v)) continue;
    // A downgraded entry (version 2 shape written over a version 3 store) keeps its groups if it has them.
    const raw = Array.isArray(v.groups) && v.groups.length > 0 ? v.groups : [{ tabs: v.tabs, activeTabId: v.activeTabId, pickFrom: v.pickFrom }];
    const groups = raw.slice(0, 2).map(sanitizeGroup);
    // A split with nothing in either group is no split.
    const bare = groups.length === 2 && groups.every((g) => g.tabs.length === 0);
    const e: PanelEntry = { open: v.open === true, groups: bare ? [emptyGroup] : groups };
    if (typeof v.width === "number" && Number.isFinite(v.width)) e.width = v.width;
    if (v.expanded === true) e.expanded = true;
    if (typeof v.ratio === "number" && v.ratio >= RATIO_MIN && v.ratio <= RATIO_MAX) e.ratio = v.ratio;
    if (v.focused === 1 && e.groups.length > 1) e.focused = 1;
    out[key] = e;
  }
  return out;
}

/**
 * Focus requests for the panel go through the ui store (panelFocusSeq), which the palette
 * also uses. Persisted whole: open state, groups (tabs in strip order, active tab,
 * picking), width, expanded, the split's ratio and the focused group survive a reload.
 */
export const usePanelStore = create<PanelState>()(
  persist(() => ({ byKey: {} }), {
    name: "code-foundry.panel",
    // 2: worktree tabs name their project with `project`, not `repo` (migratePanelV1).
    // 3: tab groups; the flat tab list is the first group (migratePanelV2).
    // 4: Worktree tabs are Changes tabs; the removed surfaces' tabs go (migratePanelV3).
    version: 4,
    migrate: (persisted, version) => {
      const byKey = ((persisted ?? {}) as { byKey?: Record<string, PanelEntryV2> }).byKey ?? {};
      if (version >= 4) return { byKey }; // a store from a newer build: merge repairs what it can
      const v3 = version >= 3 ? byKey : migratePanelV2(version < 2 ? migratePanelV1(byKey) : byKey);
      return { byKey: migratePanelV3(sanitizePanelState(v3)) };
    },
    // Every rehydrate, migrated or not, goes through sanitizePanelState: a store another
    // build wrote is never trusted as is.
    merge: (persisted, current) => ({ ...current, byKey: sanitizePanelState((persisted as { byKey?: unknown } | undefined)?.byKey) }),
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
 * the window's selection), adds or activates the tab, and makes the panel visible. A new
 * tab goes to `group` (a group's "+" or surface list), by default the focused group (the
 * last one the user interacted with); a tab already open in either group is activated
 * where it is (openTab). Returns false when there is no panel to open (nothing selected).
 * It does not request focus.
 */
export function openSurface(target: PanelTarget, tab: Tab, opts: { group?: GroupIndex } = {}): boolean {
  return update(target, (e) => openTab(e, tab, opts.group)) !== null;
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

/**
 * Closes a tab, in whichever group holds it (closeTab). Whether closing the panel's last
 * one keeps the panel open is the appearance.panel_keep_open setting unless `keepOpen` is
 * given. Every path that removes a side panel tab comes through here.
 */
export function closePanelTab(target: PanelTarget, id: string, opts: { keepOpen?: boolean } = {}): void {
  const keepOpen = opts.keepOpen ?? panelKeepOpen();
  update(target, (e) => closeTab(e, id, keepOpen));
}

/** Sets a tab's title in its strip (retitleTab). */
export function retitlePanelTab(target: PanelTarget, id: string, title: string): void {
  update(target, (e) => retitleTab(e, id, title));
}

/** Activates a tab in its group, which takes focus (activateTab). */
export function activatePanelTab(target: PanelTarget, id: string): void {
  update(target, (e) => activateTab(e, id));
}

/** Moves a tab to `toIndex` in its group's strip (moveTab); the order is persisted with the rest. */
export function movePanelTab(target: PanelTarget, id: string, toIndex: number): void {
  update(target, (e) => moveTab(e, id, toIndex));
}

/** Moves a tab to the other group at `toIndex` (moveTabToGroup), splitting an unsplit panel or collapsing an emptied group. */
export function movePanelTabToGroup(target: PanelTarget, id: string, group: GroupIndex, toIndex?: number): void {
  update(target, (e) => moveTabToGroup(e, id, group, toIndex));
}

/**
 * Shows a group's surface list to open another tab (startPicking; default: the focused
 * group), showing the panel if it is hidden. A group without tabs shows the list anyway,
 * so the panel is only shown. Showing asks the panel to take focus (so Escape and the
 * surface letters work at once) unless `focus` is false. Returns false when there is no
 * panel (nothing selected). The view.panel.new-tab command is newPanelTabCommand
 * (stores/views.ts).
 */
export function startPanelPicking(target: PanelTarget = "current", opts: { focus?: boolean; group?: GroupIndex } = {}): boolean {
  return update(target, (e) => startPicking(toggle(e, true), opts.group), { focus: opts.focus ?? true }) !== null;
}

/** Leaves picking without a pick (stopPicking; default: the focused group): back to the tab that was active, or the split collapses. */
export function stopPanelPicking(target: PanelTarget = "current", group?: GroupIndex): void {
  update(target, (e) => stopPicking(e, group));
}

/**
 * Splits a panel into two groups (split), showing it if it is hidden. Showing asks the
 * panel to take focus unless `focus` is false. Returns whether the panel is now split
 * (false with nothing selected, or no tabs to split).
 */
export function splitPanel(target: PanelTarget = "current", opts: { focus?: boolean } = {}): boolean {
  const key = update(target, (e) => split(toggle(e, true)), { focus: opts.focus ?? true });
  const e = key === null ? undefined : usePanelStore.getState().byKey[key];
  return e !== undefined && isSplit(e);
}

/** Joins a split panel's groups into one (unsplit). */
export function unsplitPanel(target: PanelTarget = "current"): void {
  update(target, unsplit);
}

/** Sets a panel's split ratio (setRatio: clamped; undefined puts it back at RATIO_DEFAULT). */
export function setPanelRatio(target: PanelTarget, ratio: number | undefined): void {
  update(target, (e) => setRatio(e, ratio));
}

/** Records the group the user interacted with (focusGroup). */
export function focusPanelGroup(target: PanelTarget, group: GroupIndex): void {
  update(target, (e) => focusGroup(e, group));
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

/**
 * Whether a panel's group (default: the focused one) is picking (isPicking): it shows
 * the surface list, with tabs but none active or, split, empty.
 */
export function usePanelPicking(key: string, group?: GroupIndex): boolean {
  return usePanelStore((s) => {
    const e = s.byKey[key];
    return e !== undefined && isPicking(e, group);
  });
}

/**
 * One of a panel's groups (the same object until it changes); the empty group for the
 * first group of a panel without an entry, undefined for a second group it does not have.
 */
export function usePanelGroup(key: string, group: GroupIndex): PanelGroup | undefined {
  return usePanelStore((s) => s.byKey[key]?.groups[group] ?? (group === 0 ? emptyGroup : undefined));
}

/** Whether a panel is split into two groups. */
export function usePanelSplit(key: string): boolean {
  return usePanelStore((s) => (s.byKey[key]?.groups.length ?? 1) > 1);
}

/** A panel's split ratio: the share of the axis its first group takes (RATIO_DEFAULT when it has none). */
export function usePanelRatio(key: string): number {
  return usePanelStore((s) => s.byKey[key]?.ratio ?? RATIO_DEFAULT);
}

/** A panel's focused group (focusedGroup): 0 unless it is split and the second group has focus. */
export function usePanelFocusedGroup(key: string): GroupIndex {
  return usePanelStore((s) => {
    const e = s.byKey[key];
    return e === undefined ? 0 : focusedGroup(e);
  });
}

/** Whether the current selection's panel is open. */
export function usePanelOpen(): boolean {
  const key = useCurrentPanelKey();
  return usePanelStore((s) => (key === null ? false : (s.byKey[key]?.open ?? false)));
}
