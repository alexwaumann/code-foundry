/**
 * The window shell's layout (LayoutService and the EventService layout source): spaces, each
 * space's tree of panes, the tabs in them, and what is stored per thread. The only file that
 * uses the generated layout types; it maps them to plain view models that follow the daemon's
 * layout JSON (internal/layout, docs/notes/shell-1-layout-model.md), so a pane tree passes to the
 * shell's geometry (src/shell/geometry) as it is. docs/notes/shell-10-layout-slice.md.
 */
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  LayoutDir,
  LayoutEdge,
  LayoutOpSchema,
  LayoutService,
  type Layout,
  type LayoutDelta,
  type LayoutEvent,
  type LayoutNode,
  type LayoutOp,
  type LayoutSpace,
  type LayoutTab,
  type ThreadLayout,
} from "@/gen/codefoundry/v1/layout_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { currentClientId } from "./events";

/** One surface in a pane. */
export interface LayoutTabView {
  id: string;
  /** thread, diff, file, pullrequest, terminal, prs, projects, compose, mcp, gallery, ember.board, plugin.<plugin>.<surface>. */
  kind: string;
  /** The thread it is linked to; "" for an unlinked tab; the thread itself for a thread tab. */
  thread: string;
  /** Its identity, computed by the daemon (two tabs with one key in one scope are the same tab). */
  key: string;
  params: Readonly<Record<string, string>>;
  /** The last automatic title. */
  title: string;
  /** A manual name (terminals); "" is automatic. */
  name: string;
}

/** A pane: one tile with a tab strip. Always has a tab. */
export interface LayoutPaneView {
  t: "pane";
  id: string;
  tabs: readonly LayoutTabView[];
  /** The active tab's id. */
  active: string;
}

/** A split: its kids side by side ("row") or stacked ("col"), sharing its length by `sizes`. */
export interface LayoutSplitView {
  t: "split";
  id: string;
  dir: "row" | "col";
  kids: readonly LayoutNodeView[];
  sizes: readonly number[];
}

export type LayoutNodeView = LayoutPaneView | LayoutSplitView;

/** A named layout: one tree of panes. */
export interface LayoutSpaceView {
  id: string;
  name: string;
  /** null for a space with no pane (it shows the composer). */
  root: LayoutNodeView | null;
  /** The focused pane; "" only when root is null. */
  focus: string;
  /** Tab ids of the space, most recently focused first. */
  mru: readonly string[];
  /** Its composer drafts, newest first, open in a tab or not (the empty composer is never one). */
  drafts: readonly LayoutDraftView[];
}

/** A composer with something typed in it; its text is not in the layout. */
export interface LayoutDraftView {
  /** The "draft" param of its compose tab. */
  id: string;
  /** One line for lists; "" draws a placeholder. */
  label: string;
  /** Its tab's other params (project, workspace, like). */
  params: Readonly<Record<string, string>>;
}

export type LayoutEdgeName = "left" | "right" | "top" | "bottom";

/** One remembered linked tab of a closed thread, and where it was. */
export interface RememberedTabView {
  tab: LayoutTabView;
  paneId: string;
  index: number;
  active: boolean;
  adjacent: boolean;
  beside: { neighbours: readonly string[]; edge: LayoutEdgeName | ""; frac: number } | null;
  fresh: { name: string; ran: string } | null;
}

/** What the layout stores for one thread. */
export interface ThreadLayoutView {
  threadId: string;
  /** The space it lives in. */
  spaceId: string;
  /** ran: the command its shell ran when a snooze ended it, for its "Run again" line ("" when none). */
  quick: { open: boolean; height: number; ran: string } | null;
  remembered: readonly RememberedTabView[];
  rememberedPaneId: string;
  /** Its info card shown or hidden as the user last toggled it (thread.info); null: never toggled, the setting layout.thread_info decides. */
  info: boolean | null;
}

/** The whole layout at one rev. */
export interface LayoutView {
  rev: number;
  /** In the order of the space tabs. */
  spaces: readonly LayoutSpaceView[];
  currentSpaceId: string;
  /** The space of every thread not in `threads`. */
  defaultSpaceId: string;
  /** Only threads with something stored. */
  threads: readonly ThreadLayoutView[];
  /** The first-load import of the classic window's panels ran (LayoutService.ImportLegacy); absent reads false. */
  legacyImported?: boolean;
  /**
   * What in the stored layout a newer build wrote (Layout.newer); absent reads none. When there is
   * any, the daemon saves no change to the layout until the app is updated.
   */
  newer?: readonly string[];
}

/** Everything one commit changed: whole spaces and whole thread records. */
export interface LayoutDeltaView {
  spaces: readonly LayoutSpaceView[];
  removedSpaceIds: readonly string[];
  /** Every space id in order. */
  spaceOrder: readonly string[];
  currentSpaceId: string;
  defaultSpaceId: string;
  threads: readonly ThreadLayoutView[];
  removedThreadIds: readonly string[];
  /** Layout.legacy_imported after the commit. */
  legacyImported?: boolean;
}

/** The EventService layout source: the whole layout on connect, then one delta per commit. */
export type LayoutEventView =
  | { kind: "snapshot"; rev: number; layout: LayoutView; clientId: string }
  | { kind: "delta"; rev: number; delta: LayoutDeltaView; clientId: string };

const dirs: Record<LayoutDir, "row" | "col" | null> = {
  [LayoutDir.UNSPECIFIED]: null,
  [LayoutDir.ROW]: "row",
  [LayoutDir.COL]: "col",
};

const edgeNames: Record<LayoutEdge, LayoutEdgeName | ""> = {
  [LayoutEdge.UNSPECIFIED]: "",
  [LayoutEdge.LEFT]: "left",
  [LayoutEdge.RIGHT]: "right",
  [LayoutEdge.TOP]: "top",
  [LayoutEdge.BOTTOM]: "bottom",
};

const edges: Record<LayoutEdgeName, LayoutEdge> = {
  left: LayoutEdge.LEFT,
  right: LayoutEdge.RIGHT,
  top: LayoutEdge.TOP,
  bottom: LayoutEdge.BOTTOM,
};

function toTab(t: LayoutTab | undefined): LayoutTabView {
  return { id: t?.id ?? "", kind: t?.kind ?? "", thread: t?.threadId ?? "", key: t?.key ?? "", params: { ...t?.params }, title: t?.title ?? "", name: t?.name ?? "" };
}

/** A node; null for an empty one (no case, a pane without tabs, a split without kids), which normal form never sends. */
function toNode(n: LayoutNode | undefined): LayoutNodeView | null {
  const v = n?.node;
  if (v?.case === "pane") {
    const tabs = v.value.tabs.map((t) => toTab(t));
    const first = tabs[0];
    if (!first) return null;
    const active = tabs.some((t) => t.id === v.value.activeTabId) ? v.value.activeTabId : first.id;
    return { t: "pane", id: v.value.id, tabs, active };
  }
  if (v?.case === "split") {
    const kids: LayoutNodeView[] = [];
    const sizes: number[] = [];
    v.value.children.forEach((c, i) => {
      const k = toNode(c);
      if (!k) return;
      kids.push(k);
      sizes.push(v.value.sizes[i] ?? 0);
    });
    if (kids.length < 2) return kids[0] ?? null;
    return { t: "split", id: v.value.id, dir: (dirs as Partial<Record<number, "row" | "col" | null>>)[v.value.dir] ?? "row", kids, sizes };
  }
  return null;
}

export function toLayoutSpaceView(s: LayoutSpace): LayoutSpaceView {
  return {
    id: s.id,
    name: s.name,
    root: toNode(s.root),
    focus: s.focusPaneId,
    mru: [...s.mruTabIds],
    drafts: s.drafts.map((d) => ({ id: d.id, label: d.label, params: { ...d.params } })),
  };
}

export function toThreadLayoutView(t: ThreadLayout): ThreadLayoutView {
  return {
    threadId: t.threadId,
    spaceId: t.spaceId,
    quick: t.quick ? { open: t.quick.open, height: t.quick.height, ran: t.quick.ran } : null,
    info: t.info ?? null,
    remembered: t.remembered.map((r) => ({
      tab: toTab(r.tab),
      paneId: r.paneId,
      index: r.index,
      active: r.active,
      adjacent: r.adjacent,
      beside: r.beside ? { neighbours: [...r.beside.neighbourPaneIds], edge: (edgeNames as Partial<Record<number, LayoutEdgeName | "">>)[r.beside.edge] ?? "", frac: r.beside.frac } : null,
      fresh: r.fresh ? { name: r.fresh.name, ran: r.fresh.ran } : null,
    })),
    rememberedPaneId: t.rememberedPaneId,
  };
}

export function toLayoutView(l: Layout | undefined): LayoutView {
  return {
    rev: Number(l?.rev ?? 0n),
    spaces: (l?.spaces ?? []).map(toLayoutSpaceView),
    currentSpaceId: l?.currentSpaceId ?? "",
    defaultSpaceId: l?.defaultSpaceId ?? "",
    threads: (l?.threads ?? []).map(toThreadLayoutView),
    legacyImported: l?.legacyImported ?? false,
    newer: [...(l?.newer ?? [])],
  };
}

function toDeltaView(d: LayoutDelta): LayoutDeltaView {
  return {
    spaces: d.spaces.map(toLayoutSpaceView),
    removedSpaceIds: [...d.removedSpaceIds],
    spaceOrder: [...d.spaceOrder],
    currentSpaceId: d.currentSpaceId,
    defaultSpaceId: d.defaultSpaceId,
    threads: d.threads.map(toThreadLayoutView),
    removedThreadIds: [...d.removedThreadIds],
    legacyImported: d.legacyImported,
  };
}

/** The layout source's event; null for a change this build does not know. */
export function toLayoutEventView(ev: LayoutEvent): LayoutEventView | null {
  const rev = Number(ev.rev);
  switch (ev.change.case) {
    case "snapshot": {
      const layout = toLayoutView(ev.change.value);
      // The event's rev is the commit; a snapshot's own rev says the same.
      return { kind: "snapshot", rev, layout: { ...layout, rev }, clientId: ev.clientId };
    }
    case "delta":
      return { kind: "delta", rev, delta: toDeltaView(ev.change.value), clientId: ev.clientId };
    default:
      return null;
  }
}

/** A tab an op opens: the daemon makes its id and key. */
export interface NewTabView {
  id?: string;
  kind: string;
  thread?: string;
  params?: Record<string, string>;
  title?: string;
  name?: string;
}

/**
 * One layout op, in the JSON form of internal/layout (the op's name and its fields, as in
 * internal/layout/testdata/ops), which the daemon's LayoutOp cases map onto one to one.
 */
export type LayoutOpView =
  | { op: "add_tab"; space?: string; pane?: string; tab: NewTabView; index?: number; focus?: boolean }
  | { op: "split_pane"; pane: string; edge: LayoutEdgeName; tab: NewTabView; frac?: number; focus?: boolean }
  | { op: "move_tab"; tab: string; space?: string; pane?: string; index?: number; edge?: LayoutEdgeName; frac?: number }
  | { op: "move_pane"; pane: string; target?: string; edge?: LayoutEdgeName; frac?: number; space?: string }
  | { op: "merge_pane"; pane: string; target: string; index?: number }
  | { op: "swap_pane"; pane: string; target: string }
  | { op: "close_tab"; tab: string }
  | { op: "close_pane"; pane: string }
  | { op: "set_sizes"; split: string; sizes: number[] }
  | { op: "focus_tab"; tab: string }
  | { op: "focus_pane"; pane: string }
  | { op: "set_tab_params"; tab: string; params: Record<string, string>; title?: string }
  | { op: "rename_tab"; tab: string; name: string }
  | { op: "new_space"; name?: string; switch?: boolean }
  | { op: "rename_space"; space: string; name: string }
  | { op: "remove_space"; space: string; to?: string }
  | { op: "reorder_spaces"; order: string[] }
  | { op: "switch_space"; space: string }
  | { op: "open_thread"; thread: string; pane?: string; focus?: boolean; compose?: string }
  | { op: "close_thread"; thread: string }
  /** behind: a tab the user is typing in; landing in its pane, the tab waits behind it (OpenSurfaceOp.behind_tab_id). */
  | { op: "open_surface"; tab: NewTabView; pane?: string; focus?: boolean; space?: string; behind?: string }
  | { op: "move_thread"; thread: string; space: string }
  | { op: "archive_thread"; thread: string }
  | { op: "snooze_thread"; thread: string; ran?: Record<string, string> }
  | { op: "new_thread"; space?: string; pane?: string; params?: Record<string, string>; focus?: boolean }
  | { op: "start_draft"; tab: string; draft?: string; label?: string }
  | { op: "label_draft"; draft: string; label: string }
  | { op: "clear_draft"; draft: string }
  | { op: "discard_draft"; draft: string }
  | { op: "open_draft"; draft: string; focus?: boolean }
  /** Only its "Run again" line is the window's to drop; terminal.quick opens, closes and sizes it. */
  | { op: "set_quick"; thread: string; open: boolean; forget_ran?: boolean };

export type LayoutOpName = LayoutOpView["op"];

function tabMsg(t: NewTabView) {
  return { id: t.id ?? "", kind: t.kind, threadId: t.thread ?? "", params: t.params ?? {}, title: t.title ?? "", name: t.name ?? "" };
}

function edgeMsg(e: LayoutEdgeName | undefined): LayoutEdge {
  return e ? edges[e] : LayoutEdge.UNSPECIFIED;
}

type OpInit = NonNullable<MessageInitShape<typeof LayoutOpSchema>["op"]>;

/** The proto form of an op (each case is the op's JSON name in camel case). */
export function toLayoutOpMessage(o: LayoutOpView): LayoutOp {
  const op = ((): OpInit => {
    switch (o.op) {
      case "add_tab":
        return { case: "addTab", value: { spaceId: o.space ?? "", paneId: o.pane ?? "", tab: tabMsg(o.tab), index: o.index, focus: o.focus ?? false } };
      case "split_pane":
        return { case: "splitPane", value: { paneId: o.pane, edge: edgeMsg(o.edge), tab: tabMsg(o.tab), frac: o.frac ?? 0, focus: o.focus ?? false } };
      case "move_tab":
        return { case: "moveTab", value: { tabId: o.tab, spaceId: o.space ?? "", paneId: o.pane ?? "", index: o.index, edge: edgeMsg(o.edge), frac: o.frac ?? 0 } };
      case "move_pane":
        return { case: "movePane", value: { paneId: o.pane, targetPaneId: o.target ?? "", edge: edgeMsg(o.edge), frac: o.frac ?? 0, spaceId: o.space ?? "" } };
      case "merge_pane":
        return { case: "mergePane", value: { paneId: o.pane, targetPaneId: o.target, index: o.index } };
      case "swap_pane":
        return { case: "swapPane", value: { paneId: o.pane, targetPaneId: o.target } };
      case "close_tab":
        return { case: "closeTab", value: { tabId: o.tab } };
      case "close_pane":
        return { case: "closePane", value: { paneId: o.pane } };
      case "set_sizes":
        return { case: "setSizes", value: { splitId: o.split, sizes: o.sizes } };
      case "focus_tab":
        return { case: "focusTab", value: { tabId: o.tab } };
      case "focus_pane":
        return { case: "focusPane", value: { paneId: o.pane } };
      case "set_tab_params":
        return { case: "setTabParams", value: { tabId: o.tab, params: o.params, title: o.title } };
      case "rename_tab":
        return { case: "renameTab", value: { tabId: o.tab, name: o.name } };
      case "new_space":
        return { case: "newSpace", value: { name: o.name ?? "", makeCurrent: o.switch ?? false } };
      case "rename_space":
        return { case: "renameSpace", value: { spaceId: o.space, name: o.name } };
      case "remove_space":
        return { case: "removeSpace", value: { spaceId: o.space, toSpaceId: o.to ?? "" } };
      case "reorder_spaces":
        return { case: "reorderSpaces", value: { spaceIds: o.order } };
      case "switch_space":
        return { case: "switchSpace", value: { spaceId: o.space } };
      case "open_thread":
        return { case: "openThread", value: { threadId: o.thread, paneId: o.pane ?? "", focus: o.focus ?? false, composeTabId: o.compose ?? "" } };
      case "close_thread":
        return { case: "closeThread", value: { threadId: o.thread } };
      case "open_surface":
        return { case: "openSurface", value: { tab: tabMsg(o.tab), paneId: o.pane ?? "", focus: o.focus ?? false, spaceId: o.space ?? "", behindTabId: o.behind ?? "" } };
      case "move_thread":
        return { case: "moveThread", value: { threadId: o.thread, spaceId: o.space } };
      case "archive_thread":
        return { case: "archiveThread", value: { threadId: o.thread } };
      case "snooze_thread":
        return { case: "snoozeThread", value: { threadId: o.thread, ran: o.ran ?? {} } };
      case "new_thread":
        return { case: "newThread", value: { spaceId: o.space ?? "", paneId: o.pane ?? "", params: o.params ?? {}, focus: o.focus ?? false } };
      case "start_draft":
        return { case: "startDraft", value: { tabId: o.tab, draftId: o.draft ?? "", label: o.label ?? "" } };
      case "label_draft":
        return { case: "labelDraft", value: { draftId: o.draft, label: o.label } };
      case "clear_draft":
        return { case: "clearDraft", value: { draftId: o.draft } };
      case "discard_draft":
        return { case: "discardDraft", value: { draftId: o.draft } };
      case "open_draft":
        return { case: "openDraft", value: { draftId: o.draft, focus: o.focus ?? false } };
      case "set_quick":
        return { case: "setQuick", value: { threadId: o.thread, open: o.open, forgetRan: o.forget_ran ?? false } };
    }
  })();
  return create(LayoutOpSchema, { op });
}

/** What an Apply reports: the commit it made (or the current rev) and what it acted on. */
export interface LayoutApplyView {
  rev: number;
  spaceId: string;
  paneId: string;
  tabId: string;
  /** The tab asked for was already open and was used. */
  existing: boolean;
  /** Tabs the op took out of the layout. */
  closed: readonly LayoutTabView[];
  /** How placement chose: "1" to "6", "pane", "focused", "compose". */
  rule: string;
  /** Linked tabs taken into their thread's remembered set (their terminals keep running). */
  kept: readonly LayoutTabView[];
  /** Terminal tabs whose terminals the caller ends (a snoozed or archived thread's). */
  ended: readonly LayoutTabView[];
  /** What an opened thread brought back: into old panes, placed fresh, and fresh shells. */
  backTabIds: readonly string[];
  placedTabIds: readonly string[];
  freshTabIds: readonly string[];
  /** Panes smart swap switched. */
  swappedPaneIds: readonly string[];
  /** The draft the op started, opened or ended. */
  draftId: string;
}

/** Reads the whole layout. */
export async function getLayout(conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<LayoutView> {
  const c = await conn.client(LayoutService);
  const res = await c.get({}, { signal });
  return toLayoutView(res.layout);
}

/** Runs one op as this window (the open event stream's client id), so its commits carry that id. */
export async function applyLayoutOp(op: LayoutOpView, conn: DaemonConnection = daemon): Promise<LayoutApplyView> {
  const c = await conn.client(LayoutService);
  const res = await c.apply({ op: toLayoutOpMessage(op), clientId: currentClientId() });
  return {
    rev: Number(res.rev),
    spaceId: res.spaceId,
    paneId: res.paneId,
    tabId: res.tabId,
    existing: res.existing,
    closed: res.closed.map((t) => toTab(t)),
    rule: res.rule,
    kept: res.kept.map((t) => toTab(t)),
    ended: res.ended.map((t) => toTab(t)),
    backTabIds: [...res.backTabIds],
    placedTabIds: [...res.placedTabIds],
    freshTabIds: [...res.freshTabIds],
    swappedPaneIds: [...res.swappedPaneIds],
    draftId: res.draftId,
  };
}

/** What the first-load import answered: the layout after it, and whether this call ran it. */
export interface LegacyImportView {
  layout: LayoutView;
  imported: boolean;
}

/**
 * The first-load import (docs/notes/shell-18-legacy-import.md): the classic window's stored side
 * panels and bottom panels, as the raw localStorage strings ("" when absent), become each thread's
 * remembered set and quick terminal. Once only: a second call answers imported false.
 */
export async function importLegacy(panelJson: string, bottomJson: string, conn: DaemonConnection = daemon): Promise<LegacyImportView> {
  const c = await conn.client(LayoutService);
  const res = await c.importLegacy({ panelJson, bottomJson, clientId: currentClientId() });
  return { layout: { ...toLayoutView(res.layout), legacyImported: true }, imported: res.imported };
}

/** Reports the pane area's size in layout px. */
export async function setLayoutViewport(width: number, height: number, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(LayoutService);
  await c.setViewport({ clientId: currentClientId(), width, height });
}
