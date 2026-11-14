/**
 * The layout slice (docs/notes/shell-10-layout-slice.md): the window shell's spaces, pane trees,
 * panes, tabs and thread records as the daemon's layout source publishes them. The daemon is
 * the only writer; this slice holds what it last confirmed, plus the two changes applied before
 * the daemon answers (focusing a tab or a pane, 2.6), which its next event confirms or corrects.
 *
 * Shape: `spaceOrder`, `trees` (per space, structure only: ids, directions, sizes), `panes` (by
 * id: tab ids, active), `tabs` (by id) and `threads` (by thread id). Applying an event keeps the
 * object identity of everything that did not change, so `usePane(id)`, `useTab(id)` and
 * `useTree(spaceId)` re-render only what changed. No component subscribes to the whole slice.
 * docs/notes/shell-10-layout-slice.md.
 */
import { create } from "zustand";
import {
  applyLayoutOp,
  getLayout,
  type LayoutApplyView,
  type LayoutDeltaView,
  type LayoutDraftView,
  type LayoutEventView,
  type LayoutNodeView,
  type LayoutOpView,
  type LayoutPaneView,
  type LayoutSpaceView,
  type LayoutTabView,
  type LayoutView,
  type ThreadLayoutView,
} from "@/api/layout";
import { isAbort } from "@/api/stream";
import type { GeoNode } from "@/shell/geometry/types";
import { resendViewport } from "@/shell/viewport";

/** A space's tree without its tabs: what a pane grid lays out. */
export type TreeNode = { t: "pane"; id: string; collapsed?: boolean } | { t: "split"; id: string; dir: "row" | "col"; kids: readonly TreeNode[]; sizes: readonly number[] };

/** A space without its tree. */
export interface SpaceEntry {
  id: string;
  name: string;
  /** The focused pane; "" when the space has no pane. */
  focus: string;
  /** Tab ids, most recently focused first. */
  mru: readonly string[];
  /** Its composer drafts, newest first (the sidebar lists them). */
  drafts: readonly LayoutDraftView[];
}

/** A pane: its tabs in strip order and the active one. */
export interface PaneEntry {
  id: string;
  spaceId: string;
  tabIds: readonly string[];
  active: string;
  /** The user collapsed it to a rail (pane.collapse). */
  collapsed?: boolean;
}

/** A tab and the pane it is in. */
export interface TabEntry extends LayoutTabView {
  paneId: string;
}

export interface LayoutState {
  /** A snapshot has arrived (with the flag on: the daemon has a layout source). */
  loaded: boolean;
  /** The first-load import of the classic window's panels has run (shell/legacyImport.ts). */
  legacyImported: boolean;
  /**
   * A newer build wrote the stored layout (LayoutView.newer): the daemon shows what this build
   * understands of it and saves no change until the app is updated (Shell's notice line).
   */
  newerBuild: boolean;
  /** The rev of the last commit applied. */
  rev: number;
  spaceOrder: readonly string[];
  currentSpaceId: string;
  /** The space of every thread without a record. */
  defaultSpaceId: string;
  spaces: Readonly<Record<string, SpaceEntry>>;
  /** Per space; null for a space with no pane. */
  trees: Readonly<Record<string, TreeNode | null>>;
  panes: Readonly<Record<string, PaneEntry>>;
  tabs: Readonly<Record<string, TabEntry>>;
  threads: Readonly<Record<string, ThreadLayoutView>>;
}

const EMPTY: LayoutState = {
  loaded: false,
  legacyImported: false,
  newerBuild: false,
  rev: 0,
  spaceOrder: [],
  currentSpaceId: "",
  defaultSpaceId: "",
  spaces: {},
  trees: {},
  panes: {},
  tabs: {},
  threads: {},
};

export const useLayoutStore = create<LayoutState>()(() => EMPTY);

/** The two ops applied before the daemon answers. */
export type FocusOp = Extract<LayoutOpView, { op: "focus_tab" | "focus_pane" }>;

/** A focus change applied before the daemon answered: dropped once the commit it made is in. */
interface Pending {
  op: FocusOp;
  /** The rev Apply answered; null while the call runs. */
  rev: number | null;
}

/** The layout the daemon last confirmed. */
let confirmed: LayoutView | null = null;
let pending: Pending[] = [];
/** A Get is running after a gap in the deltas; deltas wait in `held` until it answers. */
let resyncing = false;
let held: Extract<LayoutEventView, { kind: "delta" }>[] = [];
/** Bumped by resetLayout and by a snapshot during a resync, so a Get started before it is ignored. */
let generation = 0;

/** Forgets everything (tests; a window that turns the shell off). */
export function resetLayout(): void {
  confirmed = null;
  pending = [];
  resyncing = false;
  held = [];
  tail = null;
  generation++;
  useLayoutStore.setState(EMPTY, true);
}

/**
 * Applies one event of the layout source. A snapshot replaces the layout. A delta whose rev is
 * not above the slice's was in the snapshot it came after and is skipped; the next rev applies;
 * a later one means events were missed, and the slice reads the whole layout again.
 */
export function applyLayoutEvent(ev: LayoutEventView): void {
  if (ev.kind === "snapshot") {
    confirmed = ev.layout;
    held = [];
    // The snapshot is the stream's whole layout now: a Get still running for a gap is older news
    // and must not land on top of it (resync drops it).
    if (resyncing) {
      resyncing = false;
      generation++;
    }
    // An answered op is in the snapshot or was lost with a restart; a running one stays on top.
    pending = pending.filter((p) => p.rev === null);
    publish();
    // A restarted daemon forgot the pane area's size.
    resendViewport();
    return;
  }
  if (resyncing) {
    held.push(ev);
    return;
  }
  if (!confirmed || ev.rev > confirmed.rev + 1) {
    held.push(ev);
    void resync();
    return;
  }
  if (ev.rev <= confirmed.rev) return;
  confirmed = applyDelta(confirmed, ev.delta, ev.rev);
  publish();
}

/** Reads the whole layout after a gap, then applies the deltas that came after it. */
async function resync(): Promise<void> {
  resyncing = true;
  const gen = generation;
  let layout: LayoutView | null = null;
  try {
    layout = await getLayout();
  } catch (err) {
    // The next gap tries again; a reconnect brings a snapshot anyway.
    if (!isAbort(err) && gen === generation) held = [];
  }
  if (gen !== generation) return;
  resyncing = false;
  const later = held.sort((a, b) => a.rev - b.rev);
  held = [];
  if (!layout) return;
  // Never back to an older revision: a snapshot or the import's answer may have moved past it.
  if (!confirmed || layout.rev > confirmed.rev) {
    confirmed = layout;
    publish();
  }
  for (const ev of later) applyLayoutEvent(ev);
}

/** A delta applied to a layout: whole spaces and whole thread records replaced. */
export function applyDelta(l: LayoutView, d: LayoutDeltaView, rev: number): LayoutView {
  const spaces = new Map(l.spaces.map((s) => [s.id, s]));
  for (const id of d.removedSpaceIds) spaces.delete(id);
  for (const s of d.spaces) spaces.set(s.id, s);
  const order = d.spaceOrder.length > 0 ? d.spaceOrder : [...spaces.keys()];
  const threads = new Map(l.threads.map((t) => [t.threadId, t]));
  for (const id of d.removedThreadIds) threads.delete(id);
  for (const t of d.threads) threads.set(t.threadId, t);
  return {
    rev,
    spaces: order.flatMap((id) => spaces.get(id) ?? []),
    currentSpaceId: d.currentSpaceId || l.currentSpaceId,
    defaultSpaceId: d.defaultSpaceId || l.defaultSpaceId,
    threads: [...threads.values()],
    // The mark is never taken back.
    legacyImported: Boolean(d.legacyImported) || Boolean(l.legacyImported),
    // Decided when the daemon loaded the layout; only a snapshot says it.
    newer: l.newer,
  };
}

/**
 * The layout the first-load import answered (api/layout.ts importLegacy): applied as the snapshot
 * it is, so the shell draws from it without waiting for the import's delta (which, coming after,
 * is then skipped as already in).
 */
export function applyImportedLayout(layout: LayoutView): void {
  if (!confirmed || layout.rev > confirmed.rev) {
    applyLayoutEvent({ kind: "snapshot", rev: layout.rev, layout, clientId: "" });
    return;
  }
  // The stream is ahead of the answer (or level with it): keep what it holds, with the mark.
  if (layout.legacyImported && !confirmed.legacyImported) {
    confirmed = { ...confirmed, legacyImported: true };
    publish();
  }
}

/**
 * The last request in the window's queue of ops (null while none is on its way), settled
 * either way so a refusal never holds back the ops after it.
 */
let tail: Promise<void> | null = null;

/**
 * Runs an op on the daemon (no change here until its event arrives), after this window's ops
 * already on their way: each LayoutService.Apply takes one op, and two requests in flight can
 * reach the daemon in either order, so one action's ops (several tabs opened, the one to show
 * last) would end with another tab active. With none on its way the op is sent at once. Each
 * caller handles its own op's refusal; the next op is sent after it either way.
 * docs/notes/shell-25i-open-order.md.
 */
export function applyLayout(op: LayoutOpView): Promise<LayoutApplyView> {
  const sent = tail === null ? applyLayoutOp(op) : tail.then(() => applyLayoutOp(op));
  const settled = sent.then(
    () => undefined,
    () => undefined,
  );
  tail = settled;
  void settled.then(() => {
    if (tail === settled) tail = null;
  });
  return sent;
}

/**
 * Runs a focus op another way than LayoutService.Apply (a command: pane.focus, tab.focus) and
 * answers the rev of the commit it made, or null when it was refused or failed.
 */
export type FocusRunner = () => Promise<number | null>;

/**
 * Focuses a tab (its pane and space) at once; the daemon's next event confirms or corrects it.
 * Resolves false when the daemon refused it (the tab went) or the call failed: the slice is
 * back to what the daemon holds. `run` sends it (default: LayoutService.Apply).
 */
export function focusTab(tabId: string, run?: FocusRunner): Promise<boolean> {
  return optimistic({ op: "focus_tab", tab: tabId }, run);
}

/** Focuses a pane at once, as focusTab. */
export function focusPane(paneId: string, run?: FocusRunner): Promise<boolean> {
  return optimistic({ op: "focus_pane", pane: paneId }, run);
}

async function optimistic(op: FocusOp, run: FocusRunner = async () => (await applyLayout(op)).rev): Promise<boolean> {
  const p: Pending = { op, rev: null };
  pending.push(p);
  publish();
  let rev: number | null;
  try {
    rev = await run();
  } catch {
    rev = null;
  }
  if (rev === null) {
    pending = pending.filter((q) => q !== p);
    publish();
    return false;
  }
  p.rev = rev;
  publish();
  return true;
}

/** The view: what the daemon confirmed, focus changes it has not yet confirmed on top. */
function publish(): void {
  if (!confirmed) return;
  const rev = confirmed.rev;
  pending = pending.filter((p) => p.rev === null || p.rev > rev);
  const view = pending.reduce((l, p) => overlayFocus(l, p.op), confirmed);
  const next = flatten(view);
  const prev = useLayoutStore.getState();
  const shared = share(prev, next);
  if (shared !== prev) useLayoutStore.setState(shared, true);
}

/**
 * A focus op applied as the daemon applies it (internal/layout FocusTab, FocusPane), without smart
 * swap: focusing a tab opens its pane when the user collapsed it; focusing a pane does not.
 */
export function overlayFocus(l: LayoutView, op: FocusOp): LayoutView {
  for (const s of l.spaces) {
    const pane = panesOfNode(s.root).find((n) => (op.op === "focus_pane" ? n.id === op.pane : n.tabs.some((t) => t.id === op.tab)));
    if (!pane) continue;
    const tab = op.op === "focus_tab" ? op.tab : pane.active;
    const opened = op.op === "focus_tab" && pane.collapsed ? { collapsed: false } : {};
    const space: LayoutSpaceView = {
      ...s,
      root: replacePane(s.root, { ...pane, active: tab, ...opened }),
      focus: pane.id,
      mru: [tab, ...s.mru.filter((m) => m !== tab)].slice(0, 64),
    };
    return { ...l, spaces: l.spaces.map((x) => (x === s ? space : x)), currentSpaceId: s.id };
  }
  return l;
}

function panesOfNode(n: LayoutNodeView | null): LayoutPaneView[] {
  if (!n) return [];
  return n.t === "pane" ? [n] : n.kids.flatMap(panesOfNode);
}

function replacePane(n: LayoutNodeView | null, pane: LayoutPaneView): LayoutNodeView | null {
  if (!n) return n;
  if (n.t === "pane") return n.id === pane.id ? pane : n;
  return { ...n, kids: n.kids.map((k) => replacePane(k, pane) ?? k) };
}

/** A layout as the slice holds it. */
function flatten(l: LayoutView): LayoutState {
  const spaces: Record<string, SpaceEntry> = {};
  const trees: Record<string, TreeNode | null> = {};
  const panes: Record<string, PaneEntry> = {};
  const tabs: Record<string, TabEntry> = {};
  const tree = (n: LayoutNodeView, spaceId: string): TreeNode => {
    if (n.t === "split") return { t: "split", id: n.id, dir: n.dir, kids: n.kids.map((k) => tree(k, spaceId)), sizes: n.sizes };
    const collapsed = n.collapsed ? { collapsed: true } : {};
    panes[n.id] = { id: n.id, spaceId, tabIds: n.tabs.map((t) => t.id), active: n.active, ...collapsed };
    for (const t of n.tabs) tabs[t.id] = { ...t, paneId: n.id };
    return { t: "pane", id: n.id, ...collapsed };
  };
  for (const s of l.spaces) {
    spaces[s.id] = { id: s.id, name: s.name, focus: s.focus, mru: s.mru, drafts: s.drafts };
    trees[s.id] = s.root ? tree(s.root, s.id) : null;
  }
  return {
    loaded: true,
    legacyImported: Boolean(l.legacyImported),
    newerBuild: (l.newer ?? []).length > 0,
    rev: l.rev,
    spaceOrder: l.spaces.map((s) => s.id),
    currentSpaceId: l.currentSpaceId,
    defaultSpaceId: l.defaultSpaceId,
    spaces,
    trees,
    panes,
    tabs,
    threads: Object.fromEntries(l.threads.map((t) => [t.threadId, t])),
  };
}

/** Whether two plain JSON values are equal. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** `next` with every entry equal to `prev`'s replaced by `prev`'s, and `prev` itself when nothing differs. */
function shareRecord<T>(prev: Readonly<Record<string, T>>, next: Record<string, T>): Readonly<Record<string, T>> {
  let changed = Object.keys(prev).length !== Object.keys(next).length;
  for (const [id, n] of Object.entries(next)) {
    const p = Object.hasOwn(prev, id) ? prev[id] : undefined;
    if (p !== undefined && same(p, n)) next[id] = p;
    else changed = true;
  }
  return changed ? next : prev;
}

function share(prev: LayoutState, next: LayoutState): LayoutState {
  const out: LayoutState = {
    loaded: next.loaded,
    legacyImported: next.legacyImported,
    newerBuild: next.newerBuild,
    rev: next.rev,
    spaceOrder: same(prev.spaceOrder, next.spaceOrder) ? prev.spaceOrder : next.spaceOrder,
    currentSpaceId: next.currentSpaceId,
    defaultSpaceId: next.defaultSpaceId,
    spaces: shareRecord(prev.spaces, { ...next.spaces }),
    trees: shareRecord(prev.trees, { ...next.trees }),
    panes: shareRecord(prev.panes, { ...next.panes }),
    tabs: shareRecord(prev.tabs, { ...next.tabs }),
    threads: shareRecord(prev.threads, { ...next.threads }),
  };
  const keys = Object.keys(out) as (keyof LayoutState)[];
  return keys.every((k) => out[k] === prev[k]) ? prev : out;
}

/** A space's tree with its tabs, as the shell's geometry reads it; null for a space with no pane. */
export function geoTree(s: Pick<LayoutState, "trees" | "panes" | "tabs">, spaceId: string): GeoNode | null {
  const node = (n: TreeNode): GeoNode => {
    if (n.t === "split") return { t: "split", id: n.id, dir: n.dir, kids: n.kids.map(node), sizes: n.sizes };
    const p = s.panes[n.id];
    const tabs = (p?.tabIds ?? []).flatMap((id) => {
      const t = s.tabs[id];
      return t ? [{ id: t.id, kind: t.kind, thread: t.thread }] : [];
    });
    return { t: "pane", id: n.id, tabs, active: p?.active, ...(p?.collapsed ? { collapsed: true } : {}) };
  };
  const root = s.trees[spaceId];
  return root ? node(root) : null;
}

/** The spaces' ids in tab order. */
export function useSpaceOrder(): readonly string[] {
  return useLayoutStore((s) => s.spaceOrder);
}

export function useCurrentSpaceId(): string {
  return useLayoutStore((s) => s.currentSpaceId);
}

export function useSpace(id: string): SpaceEntry | undefined {
  return useLayoutStore((s) => s.spaces[id]);
}

/** A space's tree (structure only); null when it has no pane, undefined when there is no such space. */
export function useTree(spaceId: string): TreeNode | null | undefined {
  return useLayoutStore((s) => s.trees[spaceId]);
}

export function usePane(id: string): PaneEntry | undefined {
  return useLayoutStore((s) => s.panes[id]);
}

export function useTab(id: string): TabEntry | undefined {
  return useLayoutStore((s) => s.tabs[id]);
}

/** A thread's stored record; undefined when nothing is stored (it lives in the default space). */
export function useThreadLayout(threadId: string): ThreadLayoutView | undefined {
  return useLayoutStore((s) => s.threads[threadId]);
}

/** The space a thread lives in. */
export function spaceOfThread(s: Pick<LayoutState, "threads" | "defaultSpaceId">, threadId: string): string {
  return s.threads[threadId]?.spaceId ?? s.defaultSpaceId;
}
