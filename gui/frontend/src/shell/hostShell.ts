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
 * id a surface made itself (makeTab: kind and params) also finds the open tab it stands for, by the
 * daemon's identity (shell/identity.ts): the same kind, link and key params, with the daemon's
 * normalisation (a pull request's slug in any case); the other params never tell tabs apart.
 * Opening goes through the daemon (open_surface), which deduplicates by the same identity and places
 * the tab; nothing here changes the slice before the daemon answers. Every request goes through the
 * window's ordered queue (stores/layout.ts applyLayout), so the ops of one action (several tabs
 * opened, the one to show last) take effect in the order made; a tab's params updates are also
 * each computed from the one before (queueParams). docs/notes/shell-25i-open-order.md.
 * See docs/notes/shell-11-pane-grid.md.
 */
import type { LayoutOpView } from "@/api/layout";
import { applyLayout, focusTab as focusTabOp, useLayoutStore, type LayoutState, type TabEntry } from "@/stores/layout";
import { requestPaneFocus } from "@/stores/shellView";
import { parseTabId, selectionTarget, type Tab } from "./tabs";
import { identityKey } from "./identity";
import { useUiStore } from "@/stores/ui";
import { layoutKindOf, seamTab } from "./kinds";
import type { TabPlace, TabPlaceGroup, TabPlaces, TabTarget } from "./host";

/** Kinds that are pages, the composer or a terminal, not a surface: never in a place. */
const NOT_PANEL = new Set(["thread", "prs", "projects", "compose", "terminal"]);

/** A target with "current" resolved to the selection's. */
export function resolveTarget(target: TabTarget): TabTarget {
  if (target !== "current") return target;
  return selectionTarget(useUiStore.getState().selection) ?? "";
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

/** The place of a target with no tabs. */
export const EMPTY_PLACE: TabPlace = { shown: false, tabs: [], groups: [{ tabs: [], active: null }], focused: 0 };

/** The last place made per target, kept while it reads the same, so selectors stay narrow. */
const lastPlaces = new Map<TabTarget, { sig: string; place: TabPlace }>();

function signature(groups: { paneId: string; tabs: TabEntry[] }[], active: (string | null)[], focused: number): string {
  return JSON.stringify([groups.map((g) => [g.paneId, g.tabs.map((t) => [t.id, t.kind, t.title, t.name, t.params])]), active, focused]);
}

/** A target's tabs in the layout now. */
export function shellPlace(s: LayoutState, target: TabTarget): TabPlace {
  const t = resolveTarget(target);
  const groups = groupsOf(s, t);
  if (groups.length === 0) return EMPTY_PLACE;
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
    // Matched by layout id: a File tab's seam id is its path (kinds.ts seamTab).
    const at = g.tabs.findIndex((x) => x.id === actives[i]);
    return { tabs, active: tabs[at] ?? null };
  });
  const place: TabPlace = { shown: true, tabs: placeGroups.flatMap((g) => g.tabs), groups: placeGroups, focused };
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

/** A layout tab by its id anywhere, or the open tab of the identity a seam id (kind and params) names among the target's. */
export function findShellTab(s: LayoutState, target: TabTarget, id: string): TabEntry | undefined {
  const byId = s.tabs[id];
  if (byId) return byId;
  const named = parseTabId(id);
  return named ? findByIdentity(s, target, named.kind, named.params) : undefined;
}

/**
 * The target's open tab that a tab of this kind (the panel's name) and params would be: the same
 * kind and the same identity key for its link (shell/identity.ts, pinned to internal/layout's), so
 * the seam finds what the daemon would deduplicate.
 */
function findByIdentity(s: LayoutState, target: TabTarget, panelKind: string, params: Tab["params"]): TabEntry | undefined {
  const kind = layoutKindOf(panelKind);
  for (const g of groupsOf(s, target)) {
    for (const t of g.tabs) {
      if (t.kind !== kind) continue;
      const want = identityKey(kind, t.thread, params);
      if (want !== null && want === identityKey(t.kind, t.thread, t.params)) return t;
    }
  }
  return undefined;
}

function apply(op: LayoutOpView): void {
  // A refusal (the tab went meanwhile) changes nothing; the layout stays the daemon's.
  void applyLayout(op).catch(() => undefined);
}

/**
 * Opens a tab through the daemon: linked to the target's thread (placed beside it by the
 * daemon's rules), into a target pane or group's pane when one is named, else the focused pane.
 * An open tab of the same identity is used instead. `focus` (the user asked for it): the tab is
 * shown and its pane takes the focus and the keyboard; false (a thread's call), nothing moves.
 */
export function shellOpenTab(target: TabTarget, tab: Tab, opts: { group?: number; behind?: string; focus?: boolean }): boolean {
  const s = useLayoutStore.getState();
  if (!s.loaded) return false;
  const t = resolveTarget(target);
  // A tab the user is typing in (`behind`) keeps the focus and the keyboard, whoever asks.
  const focus = opts.focus === true && opts.behind === undefined;
  const open = s.tabs[tab.id] ?? findByIdentity(s, t, tab.kind, tab.params);
  if (open) {
    // Behind any update of this tab still on its way (a save's), so the newest request lands last.
    const base = pendingParams.get(open.id)?.params ?? open.params;
    // The focus first: what the user asked to see is shown before its params land.
    if (focus) showOpenTab(s, open);
    if (JSON.stringify(tab.params) !== JSON.stringify(base) || (tab.title && tab.title !== open.title)) queueParams(open.id, { ...tab.params }, tab.title || undefined);
    return true;
  }
  const pane = t.startsWith("pane:") ? t.slice(5) : opts.group !== undefined ? groupsOf(s, t)[opts.group]?.paneId : undefined;
  const thread = threadOfShellTarget(t);
  const behind = opts.behind === undefined ? undefined : findShellTab(s, t, opts.behind)?.id;
  const op: LayoutOpView = {
    op: "open_surface",
    tab: { kind: layoutKindOf(tab.kind), ...(thread ? { thread } : {}), params: { ...tab.params }, ...(tab.title ? { title: tab.title } : {}) },
    ...(pane ? { pane } : {}),
    focus,
    ...(behind ? { behind } : {}),
  };
  if (!focus) apply(op);
  else
    void applyLayout(op)
      .then(async (res) => {
        // The keyboard follows once the pane draws the tab: asked for earlier, it reached the tab still showing.
        await whenRev(res.rev);
        if (res.paneId) requestPaneFocus(res.paneId);
      })
      .catch(() => undefined);
  return true;
}

/** An open tab the user asked for: active in its pane, the pane focused, the keyboard in it. Nothing moves when it already is. */
function showOpenTab(s: LayoutState, tab: TabEntry): void {
  if (s.spaces[s.currentSpaceId]?.focus === tab.paneId && s.panes[tab.paneId]?.active === tab.id) return;
  void focusTabOp(tab.id);
  requestPaneFocus(tab.paneId);
}

/** Resolves once the layout slice holds the commit at `rev`, or after 2s (a dropped stream resyncs on its own). */
function whenRev(rev: number): Promise<void> {
  if (useLayoutStore.getState().rev >= rev) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(done, 2000);
    const unsub = useLayoutStore.subscribe((l) => {
      if (l.rev >= rev) done();
    });
  });
}

/** Makes a tab active in its pane (and its pane focused, as the slice's focus does). */
export function shellActivateTab(target: TabTarget, id: string): void {
  const tab = findShellTab(useLayoutStore.getState(), target, id);
  if (tab) void focusTabOp(tab.id);
}

export function shellRetitleTab(target: TabTarget, id: string, title: string): void {
  const tab = findShellTab(useLayoutStore.getState(), target, id);
  if (tab && title && tab.title !== title) queueParams(tab.id, pendingParams.get(tab.id)?.params ?? tab.params, title);
}

/**
 * A tab's params updates still on their way to the daemon: each is computed from the one before
 * it, not from the layout's last confirmed params, and sent after it (the window's queue). Two
 * updates in a row (a File tab's save stamps the request, then ends it) would otherwise each
 * start from the same stale params.
 */
const pendingParams = new Map<string, { params: Tab["params"]; chain: Promise<void> }>();

export function shellSetTabParams(target: TabTarget, id: string, params: Tab["params"] | ((old: Tab["params"]) => Tab["params"])): void {
  const tab = findShellTab(useLayoutStore.getState(), target, id);
  if (!tab) return;
  const base = pendingParams.get(tab.id)?.params ?? tab.params;
  const next = typeof params === "function" ? params(base) : params;
  if (JSON.stringify(next) === JSON.stringify(base)) return;
  queueParams(tab.id, next);
}

/** Sends a tab's params (and title) after the window's ops already on their way, its own among them. */
function queueParams(tabId: string, params: Tab["params"], title?: string): void {
  const chain = applyLayout({ op: "set_tab_params", tab: tabId, params: { ...params }, ...(title ? { title } : {}) }).then(
    () => undefined,
    // A refusal (the tab went meanwhile) changes nothing; the layout stays the daemon's.
    () => undefined,
  );
  pendingParams.set(tabId, { params, chain });
  void chain.then(() => {
    if (pendingParams.get(tabId)?.chain === chain) pendingParams.delete(tabId);
  });
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
  queueParams(old.id, { ...tab.params }, tab.title || undefined);
}
