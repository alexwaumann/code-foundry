/**
 * The mock daemon's layout (docs/notes/shell-plan.md 2.14): LayoutService, the layout event
 * source, and seeds that give the GUI and e2e any tree they need.
 *
 * The state and its ops follow internal/layout's JSON (docs/notes/shell-1-layout-model.md). The
 * mechanical ops (tabs, panes, sizes, focus, spaces) are a port of internal/layout's, pinned to
 * the same cases (internal/layout/testdata/ops, mock/layout.test.ts). The rules are not ported:
 * placement, a thread's remembered set, smart swap. A linked surface opens "focused if open, else
 * in the first pane holding its thread's linked tabs, else in a new pane right of its thread";
 * opening a thread puts its tab in the focused pane; closing one closes its linked tabs in its
 * space and remembers nothing; moving a thread is not run. Daemon rules are tested in Go; a
 * browser test seeds the tree it needs (POST /__mock/layout).
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { LayoutDir, LayoutEdge, type LayoutEventSchema, type LayoutOp, type LayoutSchema, type LayoutSpaceSchema, type LayoutTab, type LayoutTabSchema, type LayoutNodeSchema, type ThreadLayoutSchema } from "../src/gen/codefoundry/v1/layout_pb";
import { outerFrac } from "../src/shell/drag/outerFrac";
import { identify as identifyTab, identityKindOf, isRefusal, type IdentityKind } from "../src/shell/identity";

// ---- The model (internal/layout/model.go's JSON) ----

export interface Tab {
  id: string;
  kind: string;
  thread?: string;
  key?: string;
  params?: Record<string, string>;
  title?: string;
  name?: string;
}

export type Dir = "row" | "col";
export type Edge = "left" | "right" | "top" | "bottom";

export interface Node {
  t: "pane" | "split";
  id: string;
  tabs?: Tab[];
  active?: string;
  dir?: Dir;
  kids?: Node[];
  sizes?: number[];
}

/** A composer with something typed in it (internal/layout/drafts.go): its id, label and its tab's other params. */
export interface Draft {
  id: string;
  label?: string;
  params?: Record<string, string>;
}

export interface Space {
  id: string;
  name: string;
  root?: Node | null;
  focus?: string;
  mru?: string[];
  drafts?: Draft[];
}

export interface RememberedTab {
  tab: Tab;
  pane: string;
  index: number;
  active?: boolean;
  adjacent?: boolean;
  beside?: { neighbours: string[]; edge: Edge; frac: number };
  fresh?: { name?: string; ran?: string };
}

export interface ThreadState {
  space: string;
  quick?: { open: boolean; height?: number };
  remembered?: { pane?: string; tabs: RememberedTab[] };
  last?: Record<string, string>;
}

export interface State {
  v: number;
  spaces: Space[];
  current_space: string;
  default_space: string;
  threads?: Record<string, ThreadState>;
}

export interface Result {
  space?: string;
  pane?: string;
  tab?: string;
  existing?: boolean;
  closed?: Tab[];
  /** How placement chose: "1" (already open), "pane", "focused", "compose"; the mock's linked placement says "mock". */
  rule?: string;
  /** The draft the op started, opened or ended. */
  draft?: string;
}

/** The settings an op runs with (internal/layout Options); smart swap is not ported. */
export interface Options {
  keep_focus?: boolean;
}

/** An op in internal/layout's JSON form: its name and its fields. */
export type Op = { op: string } & Record<string, unknown>;

export type ErrorCode = "not_found" | "invalid_argument" | "already_exists" | "failed_precondition" | "unimplemented";

/** A refused op, by internal/layout's error kinds (and unimplemented for an op not run here). */
export class LayoutError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: ErrorCode, message: string): never {
  throw new LayoutError(code, message);
}

const MAX_MRU = 64;

// ---- Identity (internal/layout/identity.go): the window's one port, src/shell/identity.ts ----

type Kind = IdentityKind;

/** A tab's kind and identity key; refuses a tab its kind does not allow. */
export function identify(t: Tab): { kind: Kind; key: string } {
  const r = identifyTab({ kind: t.kind, thread: t.thread ?? "", params: t.params ?? {} });
  return isRefusal(r) ? fail("invalid_argument", r.refused) : r;
}

function isLinked(t: Tab): boolean {
  return !!t.thread && t.kind !== "thread";
}

// ---- The tree (internal/layout/tree.go) ----

const MIN_FRAC = 0.05;
const MAX_FRAC = 0.95;
const DEFAULT_FRAC = 0.5;
const BAD_SIZE = 0.0001;

function walk(n: Node | null | undefined, f: (n: Node) => void): void {
  if (!n) return;
  f(n);
  for (const k of n.kids ?? []) walk(k, f);
}

function splits(n: Node | null | undefined): Node[] {
  const out: Node[] = [];
  walk(n, (m) => {
    if (m.t === "split") out.push(m);
  });
  return out;
}

export function panes(n: Node | null | undefined): Node[] {
  const out: Node[] = [];
  walk(n, (m) => {
    if (m.t === "pane") out.push(m);
  });
  return out;
}

function paneIds(n: Node | null | undefined): string[] {
  return panes(n).map((p) => p.id);
}

function tabIndex(p: Node, id: string | undefined): number {
  return (p.tabs ?? []).findIndex((t) => t.id === id);
}

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function norm(n: Node | null | undefined): Node | null {
  if (!n) return null;
  if (n.t === "pane") {
    // In place, as Go's DeleteFunc: an op may hold this array across a removal.
    n.tabs ??= [];
    if (n.tabs.length === 0) return null;
    if (tabIndex(n, n.active) < 0) n.active = n.tabs[0]?.id;
    return n;
  }
  const kidsIn = n.kids ?? [];
  if ((n.sizes ?? []).length !== kidsIn.length) n.sizes = kidsIn.map(() => 1);
  const kids: Node[] = [];
  const sizes: number[] = [];
  kidsIn.forEach((k, i) => {
    const c = norm(k);
    if (!c) return;
    let s = n.sizes?.[i] ?? 0;
    if (!(s > 0) || !Number.isFinite(s)) s = BAD_SIZE;
    if (c.t === "split" && c.dir === n.dir) {
      const cs = c.sizes ?? [];
      const tot = sum(cs);
      (c.kids ?? []).forEach((g, j) => {
        kids.push(g);
        sizes.push((s * (cs[j] ?? 0)) / tot);
      });
      return;
    }
    kids.push(c);
    sizes.push(s);
  });
  if (kids.length < 2) return kids[0] ?? null;
  const tot = sum(sizes);
  n.kids = kids;
  n.sizes = Math.abs(tot - 1) > 1e-12 ? sizes.map((x) => x / tot) : sizes;
  return n;
}

function parentOf(root: Node | null | undefined, id: string): { par: Node | null; idx: number; node: Node | null } {
  if (!root) return { par: null, idx: -1, node: null };
  if (root.id === id) return { par: null, idx: -1, node: root };
  const kids = root.kids ?? [];
  for (const [i, k] of kids.entries()) {
    if (k.id === id) return { par: root, idx: i, node: k };
    const r = parentOf(k, id);
    if (r.node) return r;
  }
  return { par: null, idx: -1, node: null };
}

function removeNode(sp: Space, id: string): void {
  const { par, idx: i, node } = parentOf(sp.root, id);
  if (!node) return;
  if (!par) {
    sp.root = null;
    return;
  }
  const sizes = par.sizes ?? [];
  const n = i > 0 ? i - 1 : i + 1;
  sizes[n] = (sizes[n] ?? 0) + (sizes[i] ?? 0);
  par.kids?.splice(i, 1);
  sizes.splice(i, 1);
  sp.root = norm(sp.root);
}

function clampFrac(f: number | undefined): number {
  if (!f || Number.isNaN(f)) return DEFAULT_FRAC;
  return Math.max(MIN_FRAC, Math.min(MAX_FRAC, f));
}

function edgeDir(e: Edge): Dir {
  return e === "left" || e === "right" ? "row" : "col";
}

function insertBeside(sp: Space, id: string, edge: Edge, node: Node, fracIn: number | undefined, newID: string): void {
  const { par, idx: i, node: target } = parentOf(sp.root, id);
  if (!target) fail("not_found", `node "${id}"`);
  const frac = clampFrac(fracIn);
  const dir = edgeDir(edge);
  const before = edge === "left" || edge === "top";
  if (par && par.dir === dir) {
    const sizes = par.sizes ?? [];
    const s = sizes[i] ?? 0;
    sizes[i] = s * (1 - frac);
    const at = before ? i : i + 1;
    par.kids?.splice(at, 0, node);
    sizes.splice(at, 0, s * frac);
  } else {
    const ns: Node = before
      ? { t: "split", id: newID, dir, kids: [node, target], sizes: [frac, 1 - frac] }
      : { t: "split", id: newID, dir, kids: [target, node], sizes: [1 - frac, frac] };
    if (!par) sp.root = ns;
    else if (par.kids) par.kids[i] = ns;
  }
  sp.root = norm(sp.root);
}

function detach(sp: Space, pane: Node, tabID: string): Tab | null {
  const tabs = pane.tabs ?? [];
  const i = tabIndex(pane, tabID);
  if (i < 0) return null;
  const [t] = tabs.splice(i, 1);
  if (!t) return null;
  if (pane.active === tabID) pane.active = tabs[Math.min(i, tabs.length - 1)]?.id ?? "";
  if (tabs.length === 0) dropPane(sp, pane.id);
  return t;
}

function dropPane(sp: Space, paneID: string): void {
  const at = paneIds(sp.root).indexOf(paneID);
  removeNode(sp, paneID);
  if (sp.focus === paneID) {
    const rest = paneIds(sp.root);
    sp.focus = rest.length > 0 ? rest[Math.min(Math.max(at, 0), rest.length - 1)] : "";
  }
}

// ---- Applying an op (internal/layout/op.go) ----

/** Makes new ids: random for the mock daemon, sequential for the shared cases. */
export type IdSource = (prefix: string) => string;

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export const randomIds: IdSource = (prefix) => prefix + Array.from({ length: 8 }, () => B32[Math.floor(Math.random() * 32)]).join("");

/** "<prefix>n1", "<prefix>n2", ... per prefix: internal/layout's SeqIDs, which the cases expect. */
export function seqIds(): IdSource {
  const next = new Map<string, number>();
  return (prefix) => {
    const n = (next.get(prefix) ?? 0) + 1;
    next.set(prefix, n);
    return `${prefix}n${String(n)}`;
  };
}

function usedIds(st: State): Set<string> {
  const used = new Set<string>();
  for (const sp of st.spaces) {
    used.add(sp.id);
    for (const d of sp.drafts ?? []) used.add(d.id);
    walk(sp.root, (n) => {
      used.add(n.id);
      for (const t of n.tabs ?? []) used.add(t.id);
    });
  }
  for (const ts of Object.values(st.threads ?? {})) {
    if (!ts.remembered) continue;
    if (ts.remembered.pane) used.add(ts.remembered.pane);
    for (const rt of ts.remembered.tabs) {
      used.add(rt.pane);
      used.add(rt.tab.id);
    }
  }
  return used;
}

class Tx {
  private used: Set<string> | null = null;
  constructor(
    readonly st: State,
    private readonly ids: IdSource,
  ) {}

  newID(prefix: string): string {
    this.used ??= usedIds(this.st);
    for (;;) {
      const id = this.ids(prefix);
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
  }

  space(id: string | undefined): Space {
    const want = id || this.st.current_space;
    return this.st.spaces.find((s) => s.id === want) ?? fail("not_found", `space "${want}"`);
  }

  spaceByID(id: string | undefined): Space {
    if (!id) fail("invalid_argument", "no space given");
    return this.space(id);
  }

  pane(id: string | undefined): { sp: Space; pane: Node } {
    if (!id) fail("invalid_argument", "no pane given");
    for (const sp of this.st.spaces) for (const p of panes(sp.root)) if (p.id === id) return { sp, pane: p };
    return fail("not_found", `pane "${id}"`);
  }

  tab(id: string | undefined): { sp: Space; pane: Node; tab: Tab } {
    if (!id) fail("invalid_argument", "no tab given");
    for (const sp of this.st.spaces) for (const p of panes(sp.root)) for (const t of p.tabs ?? []) if (t.id === id) return { sp, pane: p, tab: t };
    return fail("not_found", `tab "${id}"`);
  }

  spaceOf(thread: string | undefined): string {
    return this.st.threads?.[thread ?? ""]?.space ?? this.st.default_space;
  }

  /** Checks a tab about to enter sp and fills its key and id; the open tab of the same identity, if any. */
  prepare(sp: Space, tb: Tab): Tab | null {
    const { kind, key } = identify(tb);
    tb.key = key;
    const draft = draftOf(tb);
    if (draft) {
      const dsp = findDraft(this.st, draft)?.sp;
      if (!dsp) fail("not_found", `draft "${draft}"`);
      if (dsp !== sp) fail("failed_precondition", `draft ${draft} belongs to space ${dsp.id}, not ${sp.id}`);
    }
    if (tb.kind === "thread" && this.spaceOf(tb.thread) !== sp.id) fail("failed_precondition", `thread ${tb.thread ?? ""} lives in space ${this.spaceOf(tb.thread)}, not ${sp.id}`);
    if (!kind.renameable) delete tb.name;
    const same = this.sameTab(sp, kind, key, "");
    if (same) return same;
    if (!tb.id) tb.id = this.newID("t-");
    else if (usedIds(this.st).has(tb.id)) fail("already_exists", `tab id "${tb.id}"`);
    return null;
  }

  sameTab(sp: Space, kind: Kind, key: string, skip: string): Tab | null {
    const spaces = kind.scope === "global" ? this.st.spaces : [sp];
    for (const s of spaces) for (const p of panes(s.root)) for (const t of p.tabs ?? []) if (t.key === key && t.id !== skip) return t;
    return null;
  }

  show(sp: Space, pane: Node, id: string, focus: boolean | undefined): void {
    if (focus) {
      focusTab(sp, pane, id);
      this.st.current_space = sp.id;
    } else if (sp.focus !== pane.id) {
      pane.active = id;
    }
    if (!sp.focus) sp.focus = pane.id;
  }

  findTab(id: string): { sp: Space; pane: Node } {
    return this.findTabOrNull(id) ?? fail("not_found", `tab "${id}"`);
  }

  findTabOrNull(id: string): { sp: Space; pane: Node } | null {
    for (const sp of this.st.spaces) for (const p of panes(sp.root)) if (tabIndex(p, id) >= 0) return { sp, pane: p };
    return null;
  }

  finish(): void {
    for (const sp of this.st.spaces) {
      sp.root = norm(sp.root);
      const ids = paneIds(sp.root);
      if (!ids.includes(sp.focus ?? "")) sp.focus = ids[0];
      if (!sp.focus) delete sp.focus;
      const open = new Set(panes(sp.root).flatMap((p) => (p.tabs ?? []).map((t) => t.id)));
      const seen = new Set<string>();
      sp.mru = (sp.mru ?? []).filter((m) => {
        const keep = open.has(m) && !seen.has(m);
        seen.add(m);
        return keep;
      });
      if (sp.mru.length === 0) delete sp.mru;
    }
    followDrafts(this.st);
  }
}

// ---- Drafts (internal/layout/drafts.go) ----

const MAX_DRAFT_LABEL = 80;

function draftOf(tb: Tab | undefined): string {
  return tb?.kind === "compose" ? (tb.params?.draft ?? "") : "";
}

/** A draft tab's params without its id. */
function draftParams(p: Record<string, string> | undefined): Record<string, string> | undefined {
  const out = { ...p };
  delete out.draft;
  return Object.keys(out).length > 0 ? out : undefined;
}

function draftLabel(s: string): string {
  const one = s.split(/\s+/).filter(Boolean).join(" ");
  const runes = Array.from(one);
  return runes.length <= MAX_DRAFT_LABEL ? one : runes.slice(0, MAX_DRAFT_LABEL).join("").trim();
}

function findDraft(st: State, id: string): { sp: Space; draft: Draft } | null {
  if (!id) return null;
  for (const sp of st.spaces) for (const d of sp.drafts ?? []) if (d.id === id) return { sp, draft: d };
  return null;
}

function draftTab(st: State, id: string): { sp: Space; pane: Node; tab: Tab } | null {
  for (const sp of st.spaces) for (const p of panes(sp.root)) for (const tb of p.tabs ?? []) if (draftOf(tb) === id) return { sp, pane: p, tab: tb };
  return null;
}

function emptyComposer(sp: Space): { pane: Node; tab: Tab } | null {
  for (const p of panes(sp.root)) for (const tb of p.tabs ?? []) if (tb.kind === "compose" && !draftOf(tb)) return { pane: p, tab: tb };
  return null;
}

function unlistDraft(st: State, id: string): void {
  const f = findDraft(st, id);
  if (!f) return;
  f.sp.drafts = (f.sp.drafts ?? []).filter((d) => d.id !== id);
  if (f.sp.drafts.length === 0) delete f.sp.drafts;
}

/** A draft whose tab is open in another space moves to the top of that space's list; each takes its tab's params. */
function followDrafts(st: State): void {
  for (const sp of st.spaces)
    for (const p of panes(sp.root))
      for (const tb of p.tabs ?? []) {
        const id = draftOf(tb);
        const f = id ? findDraft(st, id) : null;
        if (!f) continue;
        if (f.sp !== sp) {
          unlistDraft(st, id);
          sp.drafts = [f.draft, ...(sp.drafts ?? [])];
        }
        const params = draftParams(tb.params);
        if (params) f.draft.params = params;
        else delete f.draft.params;
      }
}

/** Puts before's focus back into after (internal/layout/keep_focus.go): a call from inside a thread. */
function keepFocus(before: State, after: State): void {
  if (after.spaces.some((s) => s.id === before.current_space)) after.current_space = before.current_space;
  for (const sp of after.spaces) {
    const old = before.spaces.find((s) => s.id === sp.id);
    if (!old) continue;
    const was = focusedTab(old);
    const p = was ? panes(sp.root).find((x) => tabIndex(x, was) >= 0) : undefined;
    if (p) {
      sp.focus = p.id;
      p.active = was;
    } else if (old.focus && paneIds(sp.root).includes(old.focus)) {
      sp.focus = old.focus;
    }
    const open = new Set(panes(sp.root).flatMap((x) => (x.tabs ?? []).map((t) => t.id)));
    sp.mru = (old.mru ?? []).filter((id) => open.has(id));
    if (sp.mru.length === 0) delete sp.mru;
  }
}

function touch(sp: Space, id: string): void {
  sp.mru = [id, ...(sp.mru ?? []).filter((m) => m !== id)].slice(0, MAX_MRU);
}

function focusTab(sp: Space, pane: Node, id: string): void {
  pane.active = id;
  sp.focus = pane.id;
  touch(sp, id);
}

function refocus(sp: Space): void {
  for (const id of sp.mru ?? []) {
    for (const p of panes(sp.root)) {
      if (tabIndex(p, id) >= 0) {
        focusTab(sp, p, id);
        return;
      }
    }
  }
}

function focusedTab(sp: Space): string {
  return panes(sp.root).find((p) => p.id === sp.focus)?.active ?? "";
}

function forget(sp: Space, ...ids: string[]): void {
  sp.mru = (sp.mru ?? []).filter((m) => !ids.includes(m));
}

function clampIndex(i: number, n: number): number {
  return Math.max(0, Math.min(i, n));
}

function str(o: Op, k: string): string {
  const v = o[k];
  return typeof v === "string" ? v : "";
}

function num(o: Op, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" ? v : undefined;
}

function edgeOf(o: Op, required: boolean): Edge | "" {
  const e = str(o, "edge");
  if (e === "" && !required) return "";
  if (e !== "left" && e !== "right" && e !== "top" && e !== "bottom") fail("invalid_argument", `edge "${e}"`);
  return e;
}

function tabArg(o: Op): Tab {
  const t = o.tab;
  if (!t || typeof t !== "object") fail("invalid_argument", "no tab given");
  return structuredClone(t as Tab);
}

/** Puts node on an edge of the whole pane area (w x h) of sp, at frac of it or, for none, its active tab's kind's size (outerFrac). */
function toOuter(t: Tx, sp: Space, node: Node, edge: Edge, frac: number | undefined, w: number, h: number): void {
  if (!sp.root) {
    sp.root = node;
    return;
  }
  const kind = (node.tabs ?? []).find((tb) => tb.id === node.active)?.kind;
  insertBeside(sp, sp.root.id, edge, node, outerFrac(sp.root, kind, edge, frac, w, h), t.newID("s-"));
}

type OpFn = (t: Tx, o: Op) => Result;

/** The ops the mock runs, by internal/layout's names. */
const ops = {
  add_tab(t: Tx, o: Op): Result {
    let sp = t.space(str(o, "space"));
    let pane: Node | undefined;
    if (str(o, "pane")) {
      const p = t.pane(str(o, "pane"));
      if (str(o, "space") && p.sp !== sp) fail("invalid_argument", `pane ${p.pane.id} is not in space ${sp.id}`);
      sp = p.sp;
      pane = p.pane;
    }
    const tb = tabArg(o);
    const same = t.prepare(sp, tb);
    if (same) {
      const at = t.findTab(same.id);
      if (tb.params !== undefined) same.params = tb.params;
      if (tb.title) same.title = tb.title;
      t.show(at.sp, at.pane, same.id, o.focus === true);
      return { space: at.sp.id, pane: at.pane.id, tab: same.id, existing: true };
    }
    pane ??= panes(sp.root).find((p) => p.id === sp.focus);
    if (!pane) {
      pane = { t: "pane", id: t.newID("p-"), tabs: [tb], active: tb.id };
      sp.root = pane;
    } else {
      const tabs = (pane.tabs ??= []);
      const index = num(o, "index");
      const at = index ?? tabIndex(pane, pane.active) + 1;
      tabs.splice(clampIndex(at, tabs.length), 0, tb);
    }
    t.show(sp, pane, tb.id, o.focus === true);
    return { space: sp.id, pane: pane.id, tab: tb.id };
  },

  split_pane(t: Tx, o: Op): Result {
    const edge = edgeOf(o, true) as Edge;
    const { sp, pane: target } = t.pane(str(o, "pane"));
    const tb = tabArg(o);
    const same = t.prepare(sp, tb);
    if (same) fail("already_exists", `${same.key ?? ""} is already open as ${same.id}`);
    const np: Node = { t: "pane", id: t.newID("p-"), tabs: [tb], active: tb.id };
    insertBeside(sp, target.id, edge, np, num(o, "frac"), t.newID("s-"));
    t.show(sp, np, tb.id, o.focus === true);
    return { space: sp.id, pane: np.id, tab: tb.id };
  },

  move_tab(t: Tx, o: Op): Result {
    const { sp: from, pane: src, tab: tb } = t.tab(str(o, "tab"));
    const edge = edgeOf(o, false);
    let to = from;
    if (str(o, "space")) to = t.space(str(o, "space"));
    let target: Node | undefined;
    if (str(o, "pane")) {
      const p = t.pane(str(o, "pane"));
      if (str(o, "space") && p.sp !== to) fail("invalid_argument", `pane ${p.pane.id} is not in space ${to.id}`);
      to = p.sp;
      target = p.pane;
    }
    if (to !== from) {
      if (tb.kind === "thread") fail("failed_precondition", `thread tab ${tb.id}: a thread moves to another space with its linked tabs`);
      const k = identify(tb).kind;
      const same = t.sameTab(to, k, tb.key ?? "", tb.id);
      if (same) fail("already_exists", `${tb.key ?? ""} is already open in space ${to.id} as ${same.id}`);
    }
    const wasFocused = focusedTab(from) === tb.id;
    const index = num(o, "index");
    if (target && edge) {
      if (target === src && (src.tabs ?? []).length === 1) {
        focusTab(to, src, tb.id);
        return { space: to.id, pane: src.id, tab: tb.id };
      }
      detach(from, src, tb.id);
      const np: Node = { t: "pane", id: t.newID("p-"), tabs: [tb], active: tb.id };
      insertBeside(to, target.id, edge, np, num(o, "frac"), t.newID("s-"));
      target = np;
    } else if (target) {
      const into = target;
      let at = index ?? (into.tabs ?? []).length;
      if (into === src) {
        const i = tabIndex(src, tb.id);
        if (i < at) at--;
        src.tabs?.splice(i, 1);
      } else {
        detach(from, src, tb.id);
      }
      const tabs = (into.tabs ??= []);
      tabs.splice(clampIndex(at, tabs.length), 0, tb);
    } else if (edge) {
      detach(from, src, tb.id);
      target = { t: "pane", id: t.newID("p-"), tabs: [tb], active: tb.id };
      toOuter(t, to, target, edge, num(o, "frac"), num(o, "w") ?? 0, num(o, "h") ?? 0);
    } else {
      if (to === from) fail("invalid_argument", "move_tab needs a pane, an edge or another space");
      detach(from, src, tb.id);
      target = panes(to.root).find((p) => p.id === to.focus);
      if (!target) {
        target = { t: "pane", id: t.newID("p-"), tabs: [tb] };
        to.root = target;
      } else {
        const tabs = (target.tabs ??= []);
        tabs.splice(tabIndex(target, target.active) + 1, 0, tb);
      }
    }
    if (to !== from) {
      forget(from, tb.id);
      if (wasFocused) refocus(from);
    }
    focusTab(to, target, tb.id);
    return { space: to.id, pane: target.id, tab: tb.id };
  },

  move_pane(t: Tx, o: Op): Result {
    const { sp: from, pane } = t.pane(str(o, "pane"));
    if (str(o, "space")) {
      if (str(o, "target") || str(o, "edge")) fail("invalid_argument", "move_pane takes a space or a target and edge, not both");
      const to = t.space(str(o, "space"));
      if (to === from) fail("invalid_argument", `pane ${pane.id} is already in space ${to.id}`);
      // Whole, in one step: each thread whose tab it holds lives in the target now and takes its
      // other linked tabs in the old space along, placed by the rules (internal/layout ops_tree.go).
      const ids: string[] = [];
      const threads: string[] = [];
      for (const tb of pane.tabs ?? []) {
        if (tb.kind === "thread") threads.push(tb.thread ?? "");
        const same = t.sameTab(to, identify(tb).kind, tb.key ?? "", tb.id);
        if (same) fail("already_exists", `${tb.key ?? ""} is already open in space ${to.id} as ${same.id}`);
        ids.push(tb.id);
      }
      let wasFocused = from.focus === pane.id;
      dropPane(from, pane.id);
      forget(from, ...ids);
      const follow: Tab[] = [];
      for (const th of threads) {
        if (t.spaceOf(th) !== from.id) continue;
        for (const p of panes(from.root))
          for (const tb of [...(p.tabs ?? [])]) {
            if (!isLinked(tb) || tb.thread !== th) continue;
            wasFocused ||= focusedTab(from) === tb.id;
            detach(from, p, tb.id);
            forget(from, tb.id);
            follow.push(tb);
          }
        ((t.st.threads ??= {})[th] ??= { space: to.id }).space = to.id;
      }
      if (wasFocused) refocus(from);
      if (!to.root) to.root = pane;
      else insertBeside(to, to.focus ?? "", "right", pane, DEFAULT_FRAC, t.newID("s-"));
      focusTab(to, pane, pane.active ?? "");
      const res: Result = { space: to.id, pane: pane.id, tab: pane.active };
      const closed: Tab[] = [];
      for (const tb of follow) {
        if (t.sameTab(to, identify(tb).kind, tb.key ?? "", tb.id)) {
          closed.push(tb);
          continue;
        }
        place(t, to, null, tb, false);
      }
      focusTab(to, pane, pane.active ?? "");
      if (closed.length) res.closed = closed;
      return res;
    }
    const edge = edgeOf(o, true) as Edge;
    if (!str(o, "target")) {
      removeNode(from, pane.id);
      toOuter(t, from, pane, edge, num(o, "frac"), num(o, "w") ?? 0, num(o, "h") ?? 0);
    } else {
      const { sp: tsp, pane: target } = t.pane(str(o, "target"));
      if (tsp !== from || target === pane) fail("invalid_argument", `pane ${pane.id} cannot move beside ${target.id}`);
      removeNode(from, pane.id);
      insertBeside(from, target.id, edge, pane, num(o, "frac"), t.newID("s-"));
    }
    focusTab(from, pane, pane.active ?? "");
    return { space: from.id, pane: pane.id, tab: pane.active };
  },

  merge_pane(t: Tx, o: Op): Result {
    const { sp, pane } = t.pane(str(o, "pane"));
    const { sp: tsp, pane: target } = t.pane(str(o, "target"));
    if (tsp !== sp || target === pane) fail("invalid_argument", `pane ${pane.id} cannot merge into ${target.id}`);
    removeNode(sp, pane.id);
    const tabs = (target.tabs ??= []);
    const index = num(o, "index");
    const at = index === undefined ? tabs.length : clampIndex(index, tabs.length);
    tabs.splice(at, 0, ...(pane.tabs ?? []));
    focusTab(sp, target, pane.active ?? "");
    return { space: sp.id, pane: target.id, tab: pane.active };
  },

  swap_pane(t: Tx, o: Op): Result {
    const { sp, pane: a } = t.pane(str(o, "pane"));
    const { sp: tsp, pane: b } = t.pane(str(o, "target"));
    if (tsp !== sp || a === b) fail("invalid_argument", `pane ${a.id} cannot swap with ${b.id}`);
    const pa = parentOf(sp.root, a.id);
    const pb = parentOf(sp.root, b.id);
    if (pa.par?.kids && pb.par?.kids) {
      pa.par.kids[pa.idx] = b;
      pb.par.kids[pb.idx] = a;
    }
    return { space: sp.id, pane: a.id };
  },

  close_tab(t: Tx, o: Op): Result {
    const { sp, pane, tab } = t.tab(str(o, "tab"));
    const wasFocused = focusedTab(sp) === tab.id;
    detach(sp, pane, tab.id);
    forget(sp, tab.id);
    if (wasFocused) refocus(sp);
    return { space: sp.id, closed: [tab] };
  },

  close_pane(t: Tx, o: Op): Result {
    const { sp } = t.pane(str(o, "pane"));
    const closed: Tab[] = [];
    // Each thread tab closes as close_thread closes it, first (the mock's: nothing is remembered).
    for (const tb of [...(t.pane(str(o, "pane")).pane.tabs ?? [])]) if (tb.kind === "thread") closed.push(...(ops.close_thread(t, { op: "close_thread", thread: tb.thread ?? "" }).closed ?? []));
    const pane = panes(sp.root).find((p) => p.id === str(o, "pane"));
    if (!pane) return { space: sp.id, closed };
    const wasFocused = sp.focus === pane.id;
    const ids = (pane.tabs ?? []).map((tb) => tb.id);
    dropPane(sp, pane.id);
    forget(sp, ...ids);
    if (wasFocused) refocus(sp);
    return { space: sp.id, closed: [...closed, ...(pane.tabs ?? [])] };
  },

  set_sizes(t: Tx, o: Op): Result {
    const id = str(o, "split");
    const sp = t.st.spaces.find((x) => splits(x.root).some((n) => n.id === id));
    const split = sp && splits(sp.root).find((n) => n.id === id);
    if (!sp || !split) fail("not_found", `split "${id}"`);
    const sizes = Array.isArray(o.sizes) ? (o.sizes as number[]) : [];
    if (sizes.length !== (split.kids ?? []).length) fail("invalid_argument", `split ${split.id} has ${String((split.kids ?? []).length)} children, got ${String(sizes.length)} sizes`);
    let tot = 0;
    for (const s of sizes) {
      if (!(s > 0) || !Number.isFinite(s)) fail("invalid_argument", `size ${String(s)}`);
      tot += s;
    }
    if (!Number.isFinite(tot)) fail("invalid_argument", "sizes too large");
    split.sizes = sizes.map((s) => s / tot);
    return { space: sp.id };
  },

  focus_tab(t: Tx, o: Op): Result {
    const { sp, pane, tab } = t.tab(str(o, "tab"));
    focusTab(sp, pane, tab.id);
    t.st.current_space = sp.id;
    return { space: sp.id, pane: pane.id, tab: tab.id };
  },

  focus_pane(t: Tx, o: Op): Result {
    const { sp, pane } = t.pane(str(o, "pane"));
    focusTab(sp, pane, pane.active ?? "");
    t.st.current_space = sp.id;
    return { space: sp.id, pane: pane.id, tab: pane.active };
  },

  set_tab_params(t: Tx, o: Op): Result {
    const { sp, pane, tab } = t.tab(str(o, "tab"));
    const next: Tab = structuredClone(tab);
    const params = o.params;
    const given = params && typeof params === "object" ? { ...(params as Record<string, string>) } : undefined;
    if (given) next.params = given;
    else delete next.params;
    // A composer's draft param is the draft ops' own: kept when left out, refused when changed.
    const id = draftOf(tab);
    if (tab.kind === "compose" && (given?.draft ?? "") !== id) {
      if (given?.draft || !id) fail("invalid_argument", "a composer's draft changes only through the draft ops");
      next.params = { ...given, draft: id };
    }
    if (typeof o.title === "string") next.title = o.title;
    const { kind, key } = identify(next);
    const same = t.sameTab(sp, kind, key, tab.id);
    if (same) fail("already_exists", `${key} is already open as ${same.id}`);
    next.key = key;
    Object.assign(tab, next);
    if (!next.params) delete tab.params;
    return { space: sp.id, pane: pane.id, tab: tab.id };
  },

  rename_tab(t: Tx, o: Op): Result {
    const { sp, pane, tab } = t.tab(str(o, "tab"));
    if (!identityKindOf(tab.kind)?.renameable) fail("failed_precondition", `a ${tab.kind} tab takes no name`);
    tab.name = str(o, "name").trim();
    return { space: sp.id, pane: pane.id, tab: tab.id };
  },

  // ---- Terminals (internal/layout/terminals.go) ----

  set_quick(t: Tx, o: Op): Result {
    const thread = str(o, "thread");
    if (!thread) fail("invalid_argument", "no thread given");
    const height = num(o, "height") ?? 0;
    if (height < 0 || !Number.isFinite(height) || height > 1e6) fail("invalid_argument", `quick terminal height ${String(height)}`);
    const open = o.open === true;
    const threads = t.st.threads ?? {};
    let ts = threads[thread];
    if (!ts && !open && height === 0) return {};
    if (!ts) {
      ts = { space: t.spaceOf(thread) };
      t.st.threads = { ...threads, [thread]: ts };
    }
    const q: { open: boolean; height?: number } = { open };
    const kept = ts.quick?.height ?? 0;
    if (height > 0) q.height = height;
    else if (kept > 0) q.height = kept;
    if (q.open || q.height) ts.quick = q;
    else delete ts.quick;
    // Go's prune: a record that stores nothing the default would not give goes.
    if (!ts.quick && !ts.remembered && Object.keys(ts.last ?? {}).length === 0 && ts.space === t.st.default_space) {
      const rest = Object.fromEntries(Object.entries(t.st.threads ?? {}).filter(([id]) => id !== thread));
      if (Object.keys(rest).length > 0) t.st.threads = rest;
      else delete t.st.threads;
    }
    return {};
  },

  new_space(t: Tx, o: Op): Result {
    let name = str(o, "name").trim();
    if (!name) {
      for (let n = t.st.spaces.length + 1; ; n++) {
        if (!t.st.spaces.some((s) => s.name === `Space ${String(n)}`)) {
          name = `Space ${String(n)}`;
          break;
        }
      }
    }
    const sp: Space = { id: t.newID("sp-"), name, root: null };
    t.st.spaces.push(sp);
    if (o.switch === true) t.st.current_space = sp.id;
    return { space: sp.id };
  },

  rename_space(t: Tx, o: Op): Result {
    const sp = t.spaceByID(str(o, "space"));
    const name = str(o, "name").trim();
    if (!name) fail("invalid_argument", "a space needs a name");
    sp.name = name;
    return { space: sp.id };
  },

  remove_space(t: Tx, o: Op): Result {
    const sp = t.spaceByID(str(o, "space"));
    if (t.st.spaces.length < 2) fail("failed_precondition", "the last space cannot be removed");
    const i = t.st.spaces.indexOf(sp);
    const to = str(o, "to") || (t.st.spaces[i > 0 ? i - 1 : 1]?.id ?? "");
    if (to === sp.id) fail("invalid_argument", `space ${sp.id} cannot move its threads to itself`);
    const closed = panes(sp.root).flatMap((p) => p.tabs ?? []);
    const target = t.spaceByID(to);
    if (sp.drafts?.length) target.drafts = [...sp.drafts, ...(target.drafts ?? [])];
    for (const ts of Object.values(t.st.threads ?? {})) {
      if (ts.space !== sp.id) continue;
      ts.space = to;
      delete ts.remembered;
      delete ts.last;
    }
    if (t.st.default_space === sp.id) t.st.default_space = to;
    if (t.st.current_space === sp.id) t.st.current_space = to;
    t.st.spaces.splice(i, 1);
    return { space: to, closed };
  },

  reorder_spaces(t: Tx, o: Op): Result {
    const order = Array.isArray(o.order) ? (o.order as string[]) : [];
    if (order.length !== t.st.spaces.length) fail("invalid_argument", `order names ${String(order.length)} spaces of ${String(t.st.spaces.length)}`);
    const next: Space[] = [];
    for (const id of order) {
      const sp = t.st.spaces.find((s) => s.id === id);
      if (!sp || next.includes(sp)) fail("invalid_argument", `order names "${id}" twice or not at all`);
      next.push(sp);
    }
    t.st.spaces = next;
    return {};
  },

  switch_space(t: Tx, o: Op): Result {
    const sp = t.spaceByID(str(o, "space"));
    t.st.current_space = sp.id;
    return { space: sp.id };
  },

  // ---- Thread ops, simplified (not pinned to the cases; the rules are Go's) ----

  open_thread(t: Tx, o: Op): Result {
    const thread = str(o, "thread");
    if (!thread) fail("invalid_argument", "no thread given");
    for (const sp of t.st.spaces)
      for (const p of panes(sp.root))
        for (const tb of p.tabs ?? [])
          if (tb.kind === "thread" && tb.thread === thread) {
            t.show(sp, p, tb.id, o.focus === true);
            return { space: sp.id, pane: p.id, tab: tb.id, existing: true };
          }
    // Sent from a composer (or opened in a space whose only tab is its empty composer): the
    // thread's tab takes the composer's place, and a draft ends.
    let compose: { sp: Space; pane: Node; tab: Tab } | null = null;
    if (str(o, "compose")) {
      compose = t.tab(str(o, "compose"));
      if (compose.tab.kind !== "compose") fail("invalid_argument", `tab ${compose.tab.id} is not a composer`);
      if (t.spaceOf(thread) !== compose.sp.id) ((t.st.threads ??= {})[thread] ??= { space: compose.sp.id }).space = compose.sp.id;
    } else if (!str(o, "pane")) {
      const sp = t.space(t.spaceOf(thread));
      const ps = panes(sp.root);
      const only = ps.length === 1 && ps[0]?.tabs?.length === 1 ? ps[0].tabs[0] : undefined;
      if (ps[0] && only?.kind === "compose" && !draftOf(only)) compose = { sp, pane: ps[0], tab: only };
    }
    if (compose) {
      const tb: Tab = { id: t.newID("t-"), kind: "thread", thread, key: `thread:${thread}` };
      const tabs = compose.pane.tabs ?? [];
      tabs[tabIndex(compose.pane, compose.tab.id)] = tb;
      if (compose.pane.active === compose.tab.id) compose.pane.active = tb.id;
      forget(compose.sp, compose.tab.id);
      t.show(compose.sp, compose.pane, tb.id, o.focus === true);
      const draft = draftOf(compose.tab);
      if (draft) unlistDraft(t.st, draft);
      return { space: compose.sp.id, pane: compose.pane.id, tab: tb.id, closed: [compose.tab], rule: "compose", ...(draft ? { draft } : {}) };
    }
    const sp = t.space(t.spaceOf(thread));
    let pane: Node | undefined;
    if (str(o, "pane")) {
      const p = t.pane(str(o, "pane"));
      if (p.sp !== sp) fail("invalid_argument", `pane ${p.pane.id} is not in thread ${thread}'s space ${sp.id}`);
      pane = p.pane;
    }
    return ops.add_tab(t, { op: "add_tab", space: sp.id, ...(pane ? { pane: pane.id } : {}), tab: { id: "", kind: "thread", thread }, focus: o.focus === true });
  },

  close_thread(t: Tx, o: Op): Result {
    const thread = str(o, "thread");
    const sp = t.space(t.spaceOf(thread));
    let own: Tab | null = null;
    const linked: string[] = [];
    for (const p of panes(sp.root))
      for (const tb of p.tabs ?? []) {
        if (tb.kind === "thread" && tb.thread === thread) own = tb;
        else if (isLinked(tb) && tb.thread === thread) linked.push(tb.id);
      }
    if (!own) return { space: sp.id };
    for (const id of linked) ops.close_tab(t, { op: "close_tab", tab: id });
    return ops.close_tab(t, { op: "close_tab", tab: own.id });
  },

  /**
   * Simplified (plan 2.14): the thread's tab and its linked tabs in its space go to the target
   * space; the thread's tab after the target's focused pane's active tab (a new pane when the space
   * has none), each linked tab by the mock's placement beside it. Linked tabs dragged to another
   * space stay there. The current space does not change.
   */
  move_thread(t: Tx, o: Op): Result {
    const thread = str(o, "thread");
    if (!thread) fail("invalid_argument", "no thread given");
    const to = t.spaceByID(str(o, "space"));
    const from = t.space(t.spaceOf(thread));
    if (from === to) fail("invalid_argument", `thread ${thread} already lives in space ${to.id}`);
    const linked: Tab[] = [];
    let own: Tab | null = null;
    let wasFocused = false;
    for (const p of panes(from.root))
      for (const tb of p.tabs ?? []) {
        if (tb.kind === "thread" && tb.thread === thread) own = tb;
        else if (isLinked(tb) && tb.thread === thread) linked.push(tb);
      }
    for (const tb of [...linked, ...(own ? [own] : [])]) {
      const at = t.findTab(tb.id);
      wasFocused ||= focusedTab(from) === tb.id;
      detach(from, at.pane, tb.id);
      forget(from, tb.id);
    }
    if (wasFocused) refocus(from);
    ((t.st.threads ??= {})[thread] ??= { space: to.id }).space = to.id;
    const res: Result = { space: to.id };
    if (own) {
      let pane = panes(to.root).find((p) => p.id === to.focus);
      if (!pane) {
        pane = { t: "pane", id: t.newID("p-"), tabs: [own] };
        to.root = pane;
      } else (pane.tabs ??= []).splice(tabIndex(pane, pane.active) + 1, 0, own);
      focusTab(to, pane, own.id);
      res.pane = pane.id;
      res.tab = own.id;
    }
    const closed: Tab[] = [];
    for (const tb of linked) {
      if (t.sameTab(to, identify(tb).kind, tb.key ?? "", tb.id)) {
        closed.push(tb);
        continue;
      }
      place(t, to, null, tb, false);
    }
    if (closed.length) res.closed = closed;
    return res;
  },

  open_surface(t: Tx, o: Op): Result {
    const tb = tabArg(o);
    if (tb.kind === "thread") fail("invalid_argument", "a thread's own tab opens with open_thread");
    let sp: Space;
    let chosen: Node | null = null;
    if (str(o, "pane")) {
      const p = t.pane(str(o, "pane"));
      if (str(o, "space") && p.sp.id !== str(o, "space")) fail("invalid_argument", `pane ${p.pane.id} is not in space ${str(o, "space")}`);
      sp = p.sp;
      chosen = p.pane;
    } else if (str(o, "space")) sp = t.space(str(o, "space"));
    else sp = t.space(isLinked(tb) ? t.spaceOf(tb.thread) : "");
    // behind: a tab the user is typing in keeps showing when the tab lands in its pane.
    const behind = str(o, "behind");
    const keep = behind && o.focus !== true ? t.findTabOrNull(behind) : null;
    const shown = keep?.pane.active === behind ? keep.pane : null;
    const res = place(t, sp, chosen, tb, o.focus === true);
    if (shown && res.pane === shown.id && tabIndex(shown, behind) >= 0) shown.active = behind;
    return res;
  },

  // ---- Drafts (internal/layout/drafts.go) ----

  new_thread(t: Tx, o: Op): Result {
    const params = o.params && typeof o.params === "object" ? { ...(o.params as Record<string, string>) } : undefined;
    if (params?.draft) fail("invalid_argument", "new_thread opens the empty composer; a draft opens with open_draft");
    return ops.open_surface(t, { op: "open_surface", space: str(o, "space"), pane: str(o, "pane"), tab: { id: "", kind: "compose", ...(params ? { params } : {}) }, focus: o.focus === true });
  },

  start_draft(t: Tx, o: Op): Result {
    const { sp, pane, tab } = t.tab(str(o, "tab"));
    if (tab.kind !== "compose") fail("invalid_argument", `tab ${tab.id} is a ${tab.kind} tab, not a composer`);
    const was = draftOf(tab);
    if (was) fail("failed_precondition", `composer ${tab.id} is already draft ${was}`);
    const given = str(o, "draft");
    const id = given.trim();
    if (!given) {
      // A new id below.
    } else if (id !== given) fail("invalid_argument", `draft id "${given}" has spaces around it`);
    else if (usedIds(t.st).has(id)) fail("already_exists", `draft id "${id}"`);
    const draft = given ? id : t.newID("d-");
    tab.params = { ...tab.params, draft };
    tab.key = identify(tab).key;
    const params = draftParams(tab.params);
    sp.drafts = [{ id: draft, label: draftLabel(str(o, "label")), ...(params ? { params } : {}) }, ...(sp.drafts ?? [])];
    return { space: sp.id, pane: pane.id, tab: tab.id, draft };
  },

  label_draft(t: Tx, o: Op): Result {
    const { sp, draft } = needDraft(t, str(o, "draft"));
    draft.label = draftLabel(str(o, "label"));
    const open = draftTab(t.st, draft.id);
    return { space: sp.id, draft: draft.id, ...(open ? { pane: open.pane.id, tab: open.tab.id } : {}) };
  },

  clear_draft(t: Tx, o: Op): Result {
    const { sp, draft } = needDraft(t, str(o, "draft"));
    unlistDraft(t.st, draft.id);
    const res: Result = { space: sp.id, draft: draft.id };
    const open = draftTab(t.st, draft.id);
    if (!open) return res;
    let pane = open.pane;
    const empty = emptyComposer(sp);
    if (empty) {
      if (focusedTab(sp) !== open.tab.id) {
        detach(sp, open.pane, open.tab.id);
        forget(sp, open.tab.id);
        return { ...res, closed: [open.tab], pane: empty.pane.id, tab: empty.tab.id };
      }
      detach(sp, empty.pane, empty.tab.id);
      forget(sp, empty.tab.id);
      res.closed = [empty.tab];
      pane = t.findTab(open.tab.id).pane;
    }
    const params = draftParams(open.tab.params);
    if (params) open.tab.params = params;
    else delete open.tab.params;
    open.tab.key = "compose";
    return { ...res, pane: pane.id, tab: open.tab.id };
  },

  discard_draft(t: Tx, o: Op): Result {
    const { sp, draft } = needDraft(t, str(o, "draft"));
    unlistDraft(t.st, draft.id);
    const res: Result = { space: sp.id, draft: draft.id };
    const open = draftTab(t.st, draft.id);
    if (open) {
      const wasFocused = focusedTab(sp) === open.tab.id;
      detach(sp, open.pane, open.tab.id);
      forget(sp, open.tab.id);
      if (wasFocused) refocus(sp);
      res.closed = [open.tab];
    }
    return res;
  },

  open_draft(t: Tx, o: Op): Result {
    const { sp, draft } = needDraft(t, str(o, "draft"));
    const res = place(t, sp, null, { id: "", kind: "compose", params: { ...draft.params, draft: draft.id } }, o.focus === true);
    return { ...res, draft: draft.id };
  },
};

function needDraft(t: Tx, id: string): { sp: Space; draft: Draft } {
  if (!id) fail("invalid_argument", "no draft given");
  return findDraft(t.st, id) ?? fail("not_found", `draft "${id}"`);
}

/**
 * Opens a surface in space sp (internal/layout/place.go): rule 1 (already open: focused where it
 * is, or moved into the caller's pane when unlinked), the caller's pane, else the focused pane,
 * else the first pane of an empty space. A linked tab of a thread whose tab is open in the space
 * is placed the mock's way, not by rules 2 to 6: after the last of its thread's linked tabs, else
 * in a new pane right of the thread's at 0.45 (rule "mock").
 */
function place(t: Tx, sp: Space, chosen: Node | null, tb: Tab, focus: boolean): Result {
  const same = t.prepare(sp, tb);
  if (same) {
    if (tb.params !== undefined) same.params = tb.params;
    if (tb.title) same.title = tb.title;
    const at = t.findTab(same.id);
    let pane = at.pane;
    if (chosen && !isLinked(same) && at.sp === sp && pane !== chosen) {
      detach(sp, pane, same.id);
      (chosen.tabs ??= []).splice(tabIndex(chosen, chosen.active) + 1, 0, same);
      pane = chosen;
    }
    t.show(at.sp, pane, same.id, focus);
    return { space: at.sp.id, pane: pane.id, tab: same.id, existing: true, rule: "1" };
  }
  const put = (p: Node, at: number, rule: string): Result => {
    const tabs = (p.tabs ??= []);
    tabs.splice(clampIndex(at, tabs.length), 0, tb);
    t.show(sp, p, tb.id, focus);
    return { space: sp.id, pane: p.id, tab: tb.id, rule };
  };
  if (chosen) return put(chosen, tabIndex(chosen, chosen.active) + 1, "pane");
  const all = panes(sp.root);
  const own = isLinked(tb) ? all.find((p) => (p.tabs ?? []).some((x) => x.kind === "thread" && x.thread === tb.thread)) : undefined;
  if (!own) {
    const fp = all.find((p) => p.id === sp.focus);
    if (!fp) {
      const np: Node = { t: "pane", id: t.newID("p-"), tabs: [tb], active: tb.id };
      sp.root = np;
      t.show(sp, np, tb.id, focus);
      return { space: sp.id, pane: np.id, tab: tb.id, rule: "focused" };
    }
    return put(fp, tabIndex(fp, fp.active) + 1, "focused");
  }
  const holding = all.find((p) => (p.tabs ?? []).some((x) => isLinked(x) && x.thread === tb.thread));
  if (holding) {
    const last = (holding.tabs ?? []).reduce((n, x, i) => (isLinked(x) && x.thread === tb.thread ? i : n), -1);
    return put(holding, last + 1, "mock");
  }
  const np: Node = { t: "pane", id: t.newID("p-"), tabs: [tb], active: tb.id };
  insertBeside(sp, own.id, "right", np, 0.45, t.newID("s-"));
  t.show(sp, np, tb.id, focus);
  return { space: sp.id, pane: np.id, tab: tb.id, rule: "mock" };
}

const opTable: Readonly<Record<string, OpFn | undefined>> = ops;

/** The ops the mock runs that are a port of Go's and pinned to its cases. */
export const PORTED_OPS = Object.keys(ops).filter((n) => !["open_thread", "close_thread", "move_thread"].includes(n));

/** The ops the mock runs, Go's or simplified. */
export function mockRuns(op: string): boolean {
  return Object.hasOwn(ops, op);
}

/** Runs an op on a copy of st. Throws a LayoutError, leaving st untouched, when it is refused. */
export function applyOp(st: State, op: Op, ids: IdSource, opts: Options = {}): { state: State; result: Result } {
  const fn = (Object.hasOwn(opTable, op.op) ? opTable[op.op] : undefined) ?? fail("unimplemented", `layout op ${op.op} is not available in the mock`);
  const t = new Tx(structuredClone(st), ids);
  const result = fn(t, op);
  t.finish();
  if (opts.keep_focus) keepFocus(st, t.st);
  return { state: t.st, result };
}

/**
 * A value's JSON with what Go's encoding leaves out dropped (empty strings, arrays and maps,
 * false, undefined) and object keys sorted, so two states that encode alike compare equal.
 */
export function canon(v: unknown): string {
  return JSON.stringify(prune(v));
}

function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => prune(x) ?? null);
  if (v === null || typeof v !== "object") return v === "" || v === false ? undefined : v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) {
    const x = prune((v as Record<string, unknown>)[k]);
    if (x === undefined || (Array.isArray(x) && x.length === 0) || (x !== null && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 0)) continue;
    out[k] = x;
  }
  return out;
}

/** A state from its JSON (a case or a seed): keys filled, empty roots null. */
export function decodeState(raw: unknown): State {
  const st = structuredClone(raw) as State;
  for (const sp of st.spaces) {
    sp.root ??= null;
    for (const p of panes(sp.root)) for (const t of p.tabs ?? []) t.key = identify(t).key;
  }
  return st;
}

/** A new database's layout: one empty space. */
export function emptyState(spaceId = "sp-main"): State {
  return { v: 1, spaces: [{ id: spaceId, name: "Main", root: null }], current_space: spaceId, default_space: spaceId };
}

// ---- The proto (internal/api/layout.go, layout_ops.go) ----

type LayoutInit = MessageInitShape<typeof LayoutSchema>;
type SpaceInit = MessageInitShape<typeof LayoutSpaceSchema>;
type NodeInit = MessageInitShape<typeof LayoutNodeSchema>;
type TabInit = MessageInitShape<typeof LayoutTabSchema>;
type ThreadInit = MessageInitShape<typeof ThreadLayoutSchema>;
export type LayoutEventInit = MessageInitShape<typeof LayoutEventSchema>;

const EDGES: Record<Edge, LayoutEdge> = { left: LayoutEdge.LEFT, right: LayoutEdge.RIGHT, top: LayoutEdge.TOP, bottom: LayoutEdge.BOTTOM };

function edgeName(e: LayoutEdge): Edge | undefined {
  return (Object.keys(EDGES) as Edge[]).find((k) => EDGES[k] === e);
}

export function tabMsg(t: Tab): TabInit {
  return { id: t.id, kind: t.kind, threadId: t.thread ?? "", key: t.key ?? "", params: t.params ?? {}, title: t.title ?? "", name: t.name ?? "" };
}

function nodeMsg(n: Node): NodeInit {
  if (n.t === "pane") return { node: { case: "pane", value: { id: n.id, tabs: (n.tabs ?? []).map(tabMsg), activeTabId: n.active ?? "" } } };
  return { node: { case: "split", value: { id: n.id, dir: n.dir === "col" ? LayoutDir.COL : LayoutDir.ROW, children: (n.kids ?? []).map(nodeMsg), sizes: n.sizes ?? [] } } };
}

function spaceMsg(sp: Space): SpaceInit {
  return {
    id: sp.id,
    name: sp.name,
    root: sp.root ? nodeMsg(sp.root) : undefined,
    focusPaneId: sp.focus ?? "",
    mruTabIds: sp.mru ?? [],
    drafts: (sp.drafts ?? []).map((d) => ({ id: d.id, label: d.label ?? "", params: d.params ?? {} })),
  };
}

function threadMsg(id: string, ts: ThreadState): ThreadInit {
  return {
    threadId: id,
    spaceId: ts.space,
    quick: ts.quick ? { open: ts.quick.open, height: ts.quick.height ?? 0 } : undefined,
    remembered: (ts.remembered?.tabs ?? []).map((r) => ({
      tab: tabMsg(r.tab),
      paneId: r.pane,
      index: r.index,
      active: r.active ?? false,
      adjacent: r.adjacent ?? false,
      beside: r.beside ? { neighbourPaneIds: r.beside.neighbours, edge: EDGES[r.beside.edge], frac: r.beside.frac } : undefined,
      fresh: r.fresh ? { name: r.fresh.name ?? "", ran: r.fresh.ran ?? "" } : undefined,
    })),
    rememberedPaneId: ts.remembered?.pane ?? "",
  };
}

export function layoutMsg(st: State, rev: number, legacyImported = false): LayoutInit {
  const threads = st.threads ?? {};
  return {
    rev: BigInt(rev),
    legacyImported,
    spaces: st.spaces.map(spaceMsg),
    currentSpaceId: st.current_space,
    defaultSpaceId: st.default_space,
    threads: Object.keys(threads)
      .sort()
      .flatMap((id) => {
        const ts = threads[id];
        return ts ? [threadMsg(id, ts)] : [];
      }),
  };
}

/** The delta from one state to the next (internal/store/layout's Diff): whole changed spaces and thread records. */
export function deltaMsg(prev: State, next: State, legacyImported = false): NonNullable<Extract<LayoutEventInit["change"], { case: "delta" }>>["value"] {
  const before = new Map(prev.spaces.map((s) => [s.id, canon(s)]));
  const ids = new Set(next.spaces.map((s) => s.id));
  const pt = prev.threads ?? {};
  const nt = next.threads ?? {};
  return {
    legacyImported,
    spaces: next.spaces.filter((s) => before.get(s.id) !== canon(s)).map(spaceMsg),
    removedSpaceIds: prev.spaces.filter((s) => !ids.has(s.id)).map((s) => s.id),
    spaceOrder: next.spaces.map((s) => s.id),
    currentSpaceId: next.current_space,
    defaultSpaceId: next.default_space,
    threads: Object.keys(nt)
      .sort()
      .flatMap((id) => {
        const ts = nt[id];
        return ts && canon(pt[id]) !== canon(ts) ? [threadMsg(id, ts)] : [];
      }),
    removedThreadIds: Object.keys(pt)
      .sort()
      .filter((id) => !(id in nt)),
  };
}

function protoTab(t: LayoutTab | undefined): Tab | undefined {
  if (!t) return undefined;
  const params = Object.keys(t.params).length > 0 ? { ...t.params } : undefined;
  return { id: t.id, kind: t.kind, ...(t.threadId ? { thread: t.threadId } : {}), ...(params ? { params } : {}), ...(t.title ? { title: t.title } : {}), ...(t.name ? { name: t.name } : {}) };
}

function protoEdge(e: LayoutEdge): Edge | "" {
  if (e === LayoutEdge.UNSPECIFIED) return "";
  return edgeName(e) ?? fail("invalid_argument", `edge ${String(e)}`);
}

/** An ApplyLayoutRequest's op in internal/layout's JSON form (internal/api/layout_ops.go). */
export function opFromProto(m: LayoutOp | undefined): Op {
  const c = m?.op;
  if (!c?.case) fail("invalid_argument", "no layout op given");
  switch (c.case) {
    case "addTab":
      return { op: "add_tab", space: c.value.spaceId, pane: c.value.paneId, tab: protoTab(c.value.tab), index: c.value.index, focus: c.value.focus };
    case "splitPane":
      return { op: "split_pane", pane: c.value.paneId, edge: protoEdge(c.value.edge), tab: protoTab(c.value.tab), frac: c.value.frac, focus: c.value.focus };
    case "moveTab":
      return { op: "move_tab", tab: c.value.tabId, space: c.value.spaceId, pane: c.value.paneId, index: c.value.index, edge: protoEdge(c.value.edge), frac: c.value.frac };
    case "movePane":
      return { op: "move_pane", pane: c.value.paneId, target: c.value.targetPaneId, edge: protoEdge(c.value.edge), frac: c.value.frac, space: c.value.spaceId };
    case "mergePane":
      return { op: "merge_pane", pane: c.value.paneId, target: c.value.targetPaneId, index: c.value.index };
    case "swapPane":
      return { op: "swap_pane", pane: c.value.paneId, target: c.value.targetPaneId };
    case "closeTab":
      return { op: "close_tab", tab: c.value.tabId };
    case "closePane":
      return { op: "close_pane", pane: c.value.paneId };
    case "setSizes":
      return { op: "set_sizes", split: c.value.splitId, sizes: [...c.value.sizes] };
    case "focusTab":
      return { op: "focus_tab", tab: c.value.tabId };
    case "focusPane":
      return { op: "focus_pane", pane: c.value.paneId };
    case "setTabParams":
      return { op: "set_tab_params", tab: c.value.tabId, params: Object.keys(c.value.params).length > 0 ? { ...c.value.params } : undefined, title: c.value.title };
    case "renameTab":
      return { op: "rename_tab", tab: c.value.tabId, name: c.value.name };
    case "newSpace":
      return { op: "new_space", name: c.value.name, switch: c.value.makeCurrent };
    case "renameSpace":
      return { op: "rename_space", space: c.value.spaceId, name: c.value.name };
    case "removeSpace":
      return { op: "remove_space", space: c.value.spaceId, to: c.value.toSpaceId };
    case "reorderSpaces":
      return { op: "reorder_spaces", order: [...c.value.spaceIds] };
    case "switchSpace":
      return { op: "switch_space", space: c.value.spaceId };
    case "openThread":
      return { op: "open_thread", thread: c.value.threadId, pane: c.value.paneId, focus: c.value.focus, compose: c.value.composeTabId };
    case "closeThread":
      return { op: "close_thread", thread: c.value.threadId };
    case "openSurface":
      return { op: "open_surface", tab: protoTab(c.value.tab), pane: c.value.paneId, focus: c.value.focus, space: c.value.spaceId, behind: c.value.behindTabId };
    case "newThread":
      return { op: "new_thread", space: c.value.spaceId, pane: c.value.paneId, params: Object.keys(c.value.params).length > 0 ? { ...c.value.params } : undefined, focus: c.value.focus };
    case "startDraft":
      return { op: "start_draft", tab: c.value.tabId, draft: c.value.draftId, label: c.value.label };
    case "labelDraft":
      return { op: "label_draft", draft: c.value.draftId, label: c.value.label };
    case "clearDraft":
      return { op: "clear_draft", draft: c.value.draftId };
    case "discardDraft":
      return { op: "discard_draft", draft: c.value.draftId };
    case "openDraft":
      return { op: "open_draft", draft: c.value.draftId, focus: c.value.focus };
    case "setQuick":
      return { op: "set_quick", thread: c.value.threadId, open: c.value.open, height: c.value.height };
    default:
      return fail("unimplemented", `layout op ${c.case} is not available in the mock`);
  }
}

const CODES: Record<ErrorCode, Code> = {
  not_found: Code.NotFound,
  invalid_argument: Code.InvalidArgument,
  already_exists: Code.AlreadyExists,
  failed_precondition: Code.FailedPrecondition,
  unimplemented: Code.Unimplemented,
};

/** A layout refusal as the daemon answers it. */
export function layoutRpcError(err: unknown): unknown {
  return err instanceof LayoutError ? new ConnectError(`layout: ${err.message}`, CODES[err.code]) : err;
}

// ---- Seeds ----

/** The seed threads' checkouts (mock/world.ts), so a seeded Diff tab shows that thread's changes. */
const SEED_WORKTREES: Readonly<Record<string, string>> = { "s-1": "/Users/dev/src/code-foundry", "s-3": "/Users/dev/src/code-foundry.worktrees/fix-resize" };
const diffTab = (thread: string): Tab => ({ id: `t-diff-${thread}`, kind: "diff", thread, params: { project: "repo-cf", worktree: SEED_WORKTREES[thread] ?? "/Users/dev/src/code-foundry" }, title: "Diff" });

/**
 * Named layouts for e2e and `make drive`, over the mock world's threads (s-1 ... s-6). "empty"
 * is a new database's: one space and no pane. POST /__mock/layout?seed=<name>, or a whole state
 * as the body (internal/layout's JSON) for any other tree.
 */
export const SEEDS: Record<string, () => State> = {
  empty: () => emptyState(),
  "one-thread": () => ({
    v: 1,
    spaces: [{ id: "sp-main", name: "Main", root: { t: "pane", id: "p-1", tabs: [{ id: "t-s1", kind: "thread", thread: "s-1" }], active: "t-s1" }, focus: "p-1", mru: ["t-s1"] }],
    current_space: "sp-main",
    default_space: "sp-main",
  }),
  "thread-and-diff": () => ({
    v: 1,
    spaces: [
      {
        id: "sp-main",
        name: "Main",
        root: {
          t: "split",
          id: "s-1",
          dir: "row",
          kids: [
            { t: "pane", id: "p-1", tabs: [{ id: "t-s1", kind: "thread", thread: "s-1" }], active: "t-s1" },
            { t: "pane", id: "p-2", tabs: [diffTab("s-1")], active: "t-diff-s-1" },
          ],
          sizes: [0.55, 0.45],
        },
        focus: "p-1",
        mru: ["t-s1", "t-diff-s-1"],
      },
    ],
    current_space: "sp-main",
    default_space: "sp-main",
  }),
  grid: () => ({
    v: 1,
    spaces: [
      {
        id: "sp-main",
        name: "Main",
        root: {
          t: "split",
          id: "s-1",
          dir: "row",
          kids: [
            {
              t: "split",
              id: "s-2",
              dir: "col",
              kids: [
                { t: "pane", id: "p-1", tabs: [{ id: "t-s1", kind: "thread", thread: "s-1" }, { id: "t-s3", kind: "thread", thread: "s-3" }], active: "t-s1" },
                { t: "pane", id: "p-3", tabs: [{ id: "t-prs", kind: "prs", title: "Pull Requests" }], active: "t-prs" },
              ],
              sizes: [0.6, 0.4],
            },
            {
              t: "split",
              id: "s-3",
              dir: "col",
              kids: [
                { t: "pane", id: "p-2", tabs: [diffTab("s-1"), diffTab("s-3")], active: "t-diff-s-1" },
                { t: "pane", id: "p-4", tabs: [{ id: "t-projects", kind: "projects", title: "Projects" }], active: "t-projects" },
              ],
              sizes: [0.5, 0.5],
            },
          ],
          sizes: [0.5, 0.5],
        },
        focus: "p-1",
        mru: ["t-s1", "t-diff-s-1", "t-prs"],
      },
    ],
    current_space: "sp-main",
    default_space: "sp-main",
  }),
  spaces: () => ({
    v: 1,
    spaces: [
      { id: "sp-main", name: "Main", root: { t: "pane", id: "p-1", tabs: [{ id: "t-s1", kind: "thread", thread: "s-1" }], active: "t-s1" }, focus: "p-1", mru: ["t-s1"] },
      { id: "sp-review", name: "Review", root: { t: "pane", id: "p-2", tabs: [{ id: "t-s3", kind: "thread", thread: "s-3" }], active: "t-s3" }, focus: "p-2", mru: ["t-s3"] },
    ],
    current_space: "sp-main",
    default_space: "sp-main",
    threads: { "s-3": { space: "sp-review" } },
  }),
};

/** The ops that lay panes out with the pane area here (a subset of internal/layout's measured ops: the mock ports no placement rules). */
const MEASURED_OPS = ["move_tab", "move_pane"];

/** op with the reported pane area when it measures one and names none (internal/layout area.go WithArea). */
function withArea(op: Op, vp: { width: number; height: number } | null): Op {
  if (!vp || !MEASURED_OPS.includes(op.op)) return op;
  const w = num(op, "w") ?? 0;
  const h = num(op, "h") ?? 0;
  return w > 0 && h > 0 ? op : { ...op, w: vp.width, h: vp.height };
}

// ---- The service ----

/** LayoutService and the layout source over one state, as internal/store/layout serves it. */
export class MockLayout {
  private st: State = emptyState();
  private revision = 0;
  /** The last SetViewport (layout px) and the client that sent it; null before any. */
  viewport: { clientId: string; width: number; height: number } | null = null;
  /** Every Apply, in order: the op as JSON and the client id. */
  applied: { op: Op; clientId: string }[] = [];
  /** The first-load import ran (Layout.legacy_imported). A new database's layout has not. */
  legacyImported = false;
  /** Every ImportLegacy call, in order, with what the window sent. */
  imports: { panelJson: string; bottomJson: string; clientId: string }[] = [];
  /** The next ImportLegacy calls fail with this message, as many times as `failImports` says (a test's). */
  importError = "";
  failImports = 0;
  /** How long the mock's ImportLegacy takes to answer, in ms (a test's: a slow first draw). */
  importDelayMs = 0;

  constructor(
    private readonly deps: {
      publish: (ev: LayoutEventInit) => void;
      ids?: IdSource;
      /** After an op's commit, as the daemon's lifecycle glue hears it (mock/world.ts ends a closed terminal tab's shell). */
      applied?: (op: Op, result: Result) => void;
    },
  ) {}

  get rev(): number {
    return this.revision;
  }

  state(): State {
    return this.st;
  }

  /** The source's snapshot event. */
  snapshotEvent(): LayoutEventInit {
    return { rev: BigInt(this.revision), change: { case: "snapshot", value: layoutMsg(this.st, this.revision, this.legacyImported) } };
  }

  get(): LayoutInit {
    return layoutMsg(this.st, this.revision, this.legacyImported);
  }

  /**
   * LayoutService.ImportLegacy: the first-load import of the classic window's panels. The import
   * itself is the daemon's (internal/layout/legacy.go, tested in Go); the mock only records what
   * the window sent and sets the mark in one commit, the layout unchanged, as a fresh install
   * does. A second call changes nothing and answers imported false.
   */
  importLegacy(panelJson: string, bottomJson: string, clientId = ""): { layout: LayoutInit; imported: boolean } {
    this.imports.push({ panelJson, bottomJson, clientId });
    if (this.failImports > 0) {
      this.failImports--;
      fail("failed_precondition", this.importError || "the import failed");
    }
    if (this.legacyImported) return { layout: this.get(), imported: false };
    this.legacyImported = true;
    this.revision++;
    this.deps.publish({ rev: BigInt(this.revision), change: { case: "delta", value: deltaMsg(this.st, this.st, true) }, clientId });
    return { layout: this.get(), imported: true };
  }

  /** Runs an op; a change is one commit (the next rev, one delta event). keep_focus is a call from inside a thread (the commands'). */
  apply(op: Op, clientId = "", opts: Options = {}): { rev: number; result: Result } {
    this.applied.push({ op, clientId });
    op = withArea(op, this.viewport);
    const { state, result } = applyOp(this.st, op, this.deps.ids ?? randomIds, opts);
    this.commit(state, clientId);
    const rev = this.revision;
    this.deps.applied?.(op, result);
    return { rev, result };
  }

  setViewport(clientId: string, width: number, height: number): void {
    if (!(width > 0 && height > 0 && width < 1e6 && height < 1e6)) fail("invalid_argument", `viewport ${String(width)} x ${String(height)}`);
    this.viewport = { clientId, width, height };
  }

  /** Replaces the layout (a seed, or a test's tree) as one commit. */
  seed(raw: State | string): void {
    const make = typeof raw === "string" ? SEEDS[raw] : undefined;
    if (typeof raw === "string" && !make) fail("not_found", `layout seed "${raw}"`);
    this.commit(decodeState(make ? make() : raw), "");
  }

  /** Back to a new database's layout; the rev keeps counting, as a client may hold one. */
  reset(): void {
    this.applied = [];
    this.viewport = null;
    this.imports = [];
    this.failImports = 0;
    this.importError = "";
    this.importDelayMs = 0;
    this.legacyImported = false;
    this.commit(emptyState(), "");
  }

  private commit(next: State, clientId: string): void {
    if (canon(next) === canon(this.st)) return;
    const prev = this.st;
    this.st = next;
    this.revision++;
    this.deps.publish({ rev: BigInt(this.revision), change: { case: "delta", value: deltaMsg(prev, next, this.legacyImported) }, clientId });
  }
}
