/**
 * Plugin surfaces on screen (docs/notes/plugins-5-gui.md): one PluginService.WatchSurface
 * per visible plugin tab (its state, view versions, log appends and toasts), the host's
 * form drafts per instance and view tab (and node tab and selected row:
 * docs/notes/plugins-layout-4-master-detail.md), collapsed sections, the master-details
 * showing their detail alone, and the acts in flight.
 *
 * Keys: a watch is per panel tab (`watchKey`: panel key + tab id); drafts and collapsed
 * sections are per instance (the daemon's `<plugin>/<surface>/<scope id>`) and scope (view
 * tab, node tab, selected row: draftKeyOf), so a tab that closes and reopens on the same
 * instance finds them again. Nothing here is persisted.
 */
import { create } from "zustand";
import { toast } from "sonner";
import { invalidateOnTransportError } from "@/api/endpoint";
import {
  actOnSurface,
  childLists,
  nodeScope,
  VIEW_LISTS,
  viewNodes,
  nodeKind,
  watchSurface,
  withChildLists,
  type FieldValue,
  type FormNodeData,
  type LogData,
  type LogLine,
  type PluginStateView,
  type PluginViewModel,
  type SurfacePhaseView,
  type SurfaceRefView,
  type SurfaceUpdateView,
  type ViewNode,
} from "@/api/plugin";
import type { UiContextView } from "@/api/command";
import { errorMessage, runStream } from "@/api/stream";
import { copyText } from "@/lib/clipboard";
import { runCommandForResult } from "./commands";
import { openUrl } from "./gh";

/** At most this many lines stay in a log node on screen (the daemon keeps the same). */
export const LOG_MAX_LINES = 2000;

export interface SurfaceEntry {
  plugin: string;
  surface: string;
  /** The daemon's instance key ("" until its first state). */
  instance: string;
  /** "connecting" until the stream's first state. */
  phase: SurfacePhaseView | "connecting";
  /** The state in words (a plugin down, failed, not responding). */
  message: string;
  pluginState: PluginStateView;
  /** The view's version (0: none yet). */
  version: number;
  view: PluginViewModel | null;
  /** The daemon made the view (the plugin's was invalid). */
  hostRendered: boolean;
  /** Why the stream failed (not available here, the daemon gone); null while it is fine. */
  error: string | null;
  /** The panel's context the watch runs with: acts carry it (SurfaceAct.context). */
  context?: UiContextView;
}

export interface PluginSurfacesState {
  watches: Readonly<Record<string, SurfaceEntry>>;
  /** Form drafts by draftKey: the fields the user changed, by field name. */
  drafts: Readonly<Record<string, Readonly<Record<string, FieldValue>>>>;
  /** Each form's last resetToken, by draftKey: a new one drops its drafts. */
  resetTokens: Readonly<Record<string, string>>;
  /**
   * The user's section toggles (true: collapsed), by draftKeyOf(instance, scope, section
   * key): per view tab, node tab and selected row, like drafts.
   */
  collapsed: Readonly<Record<string, boolean>>;
  /** Elements whose act or command is in flight, by watch key then element key. */
  pending: Readonly<Record<string, Readonly<Record<string, true>>>>;
  /**
   * Forms whose submit the plugin took, by draftKey: the view version it acted on. The
   * first newer view decides: drafts go when it shows the form without errors (or not at
   * all), and stay (the user's values beside the plugin's errors) when it has some.
   */
  submitted: Readonly<Record<string, number>>;
  /**
   * Master-details showing their detail alone in the narrow layout (the user chose a row),
   * by draftKeyOf(instance, scope, node key): the node's resetToken and selected row as
   * last seen. A new view drops one whose resetToken changed or whose selected row changed
   * to a key that is not a row (reconcileDetails); Back drops it.
   */
  details: Readonly<Record<string, DetailOpen>>;
  /**
   * The user's latest choice per chooser (the view's tabs, a tabs node, a master-detail),
   * by watch key then chooserKeyOf: what reads as chosen until the plugin's view says
   * otherwise (chooseElement).
   */
  choices: Readonly<Record<string, Readonly<Record<string, Choice>>>>;
}

/**
 * A tab or row the user chose, shown as chosen from the click until the plugin's view
 * shows it after its act was answered (the daemon answers the act when the plugin returns,
 * and publishes the view the plugin sent meanwhile up to DefaultCoalesce, 100 ms, later;
 * a view sent before the act can still arrive after the answer), at most CHOICE_HOLD_MS
 * after the answer; or until the act fails, or a later choice on the same chooser
 * replaces it.
 */
export interface Choice {
  key: string;
  /** Orders the choices (a later one replaces an earlier one; the earlier act's answer is then ignored). */
  seq: number;
  /** The view version the act named. */
  version: number;
  /** The plugin took the act: the next view ends the choice. */
  answered: boolean;
}

/** A master-detail showing its detail alone: its resetToken and selected row as last seen. */
export interface DetailOpen {
  token: string;
  selected: string;
}

export const usePluginSurfacesStore = create<PluginSurfacesState>()(() => ({ watches: {}, drafts: {}, resetTokens: {}, collapsed: {}, pending: {}, submitted: {}, details: {}, choices: {} }));

/** A tab's watch key: its panel's key and its id. */
export function watchKeyOf(panelKey: string, tabId: string): string {
  return `${panelKey}\u0000${tabId}`;
}

/**
 * Where a form's drafts live: the instance, its scope (the view tab, "" without tabs,
 * followed by the scope of each tabs node and master-detail around it: api/plugin.ts
 * nodeScope) and the form's key. A master-detail's narrow state uses the same key shape.
 */
export function draftKeyOf(instance: string, viewTab: string, formKey: string): string {
  return `${instance}\u0000${viewTab}\u0000${formKey}`;
}

/**
 * A chooser's key: a tabs node or master-detail by draftKeyOf(instance, scope, node key)
 * (a master-detail's is also its narrow state's key), the view's tabs by
 * draftKeyOf(instance, "", "") (node keys are never empty).
 */
export function chooserKeyOf(instance: string, scope: string, nodeKey: string): string {
  return draftKeyOf(instance, scope, nodeKey);
}

/** The value a chooser has in a view (the active tab, the selected row), or undefined when the view does not show it. */
export function chooserValue(view: PluginViewModel, instance: string, chooser: string): string | undefined {
  if (chooser === chooserKeyOf(instance, "", "")) return view.tabs?.active ?? "";
  const tab = view.tabs?.active ?? "";
  let out: string | undefined;
  walkScoped(viewNodes(view), (n, scope) => {
    if (out !== undefined || (!n.tabs && !n.masterDetail)) return;
    if (chooserKeyOf(instance, tab + scope, n.key) !== chooser) return;
    out = n.tabs ? n.tabs.active : (n.masterDetail?.selected ?? "");
  });
  return out;
}

/**
 * Ends choices (by chooser) against the view on screen: each goes, and a master-detail
 * the view shows with another row selected than its ended choice goes back to its list
 * (the plugin did not take the row, or took it and moved on): its detail would show
 * another row's. One the view does not show keeps its state (reconcileDetails).
 */
function endChoices(s: PluginSurfacesState, watchKey: string, ended: readonly string[]): Partial<PluginSurfacesState> {
  const mine = s.choices[watchKey];
  if (!mine || ended.length === 0) return {};
  const e = s.watches[watchKey];
  let rest: Readonly<Record<string, Choice>> = mine;
  let details = s.details;
  for (const chooser of ended) {
    const c = rest[chooser];
    if (!c) continue;
    const { [chooser]: _ended, ...others } = rest;
    rest = others;
    const now = chooser in details && e?.view ? chooserValue(e.view, e.instance, chooser) : undefined;
    if (now !== undefined && now !== c.key) {
      const { [chooser]: _gone, ...d } = details;
      details = d;
    }
  }
  return { choices: { ...s.choices, [watchKey]: rest }, details };
}

export function emptyEntry(ref: Pick<SurfaceRefView, "plugin" | "surface">): SurfaceEntry {
  return { plugin: ref.plugin, surface: ref.surface, instance: "", phase: "connecting", message: "", pluginState: "unknown", version: 0, view: null, hostRendered: false, error: null };
}

// ---------------------------------------------------------------------------------------
// Pure reducers

/** Splits text into lines; a trailing newline ends the last line rather than starting one. */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A log with appended text or lines, trimmed to LOG_MAX_LINES from the head. */
export function appendToLog(log: LogData, text: string, lines: readonly LogLine[]): LogData {
  if (log.lines !== undefined && log.lines.length > 0) {
    const more = lines.length > 0 ? lines : splitLines(text).map((t) => ({ text: t }));
    const all = [...log.lines, ...more];
    const cut = all.length - LOG_MAX_LINES;
    return cut > 0 ? { ...log, lines: all.slice(cut), truncated: true } : { ...log, lines: all };
  }
  if (lines.length > 0 && !log.text) {
    // A log with nothing yet takes the lines' form.
    const cut = lines.length - LOG_MAX_LINES;
    return cut > 0 ? { ...log, lines: lines.slice(cut), truncated: true } : { ...log, lines: [...lines] };
  }
  const joined = (log.text ?? "") + (lines.length > 0 ? lines.map((l) => `${l.text}\n`).join("") : text);
  const all = joined.split("\n");
  // The text's last line may be partial (no newline yet): count lines up to it.
  const cut = all.length - 1 - LOG_MAX_LINES;
  return cut > 0 ? { ...log, text: all.slice(cut).join("\n"), truncated: true } : { ...log, text: joined };
}

/** Replaces the node with `key` (at any depth) by f(node); the same array when it is not there. */
function mapNode(nodes: readonly ViewNode[], key: string, f: (n: ViewNode) => ViewNode): ViewNode[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    if (n.key === key) {
      const out = [...nodes];
      out[i] = f(n);
      return out;
    }
    const lists = childLists(n);
    for (let j = 0; j < lists.length; j++) {
      const children = mapNode(lists[j] ?? [], key, f);
      if (children) {
        const out = [...nodes];
        // The other lists keep their identity (memoized renderers skip them).
        out[i] = withChildLists(
          n,
          lists.map((l, k) => (k === j ? children : l)),
        );
        return out;
      }
    }
  }
  return null;
}

/** The view with one log node extended (view/append); the same view when the key names no log. */
export function appendToView(view: PluginViewModel, key: string, text: string, lines: readonly LogLine[]): PluginViewModel {
  for (const list of VIEW_LISTS) {
    const hit = { log: false };
    const nodes = mapNode(view[list] ?? [], key, (n) => {
      if (!n.log) return n;
      hit.log = true;
      return { ...n, log: appendToLog(n.log, text, lines) };
    });
    if (nodes) return hit.log ? { ...view, [list]: nodes } : view;
  }
  return view;
}

/** Deep equality of plain data (a view's nodes: objects, arrays, strings, numbers, booleans). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const ob = b as Record<string, unknown>;
  return ka.length === Object.keys(ob).length && ka.every((k) => k in ob && same((a as Record<string, unknown>)[k], ob[k]));
}

/**
 * `next`'s nodes with `prev`'s node objects (matched by key) wherever they are equal, at
 * any depth, so the memoized renderers (NodeList NodeView) skip what a new view did not
 * change; the same `prev` array when nothing changed. Pure.
 */
export function shareNodes(prev: readonly ViewNode[], next: readonly ViewNode[]): readonly ViewNode[] {
  if (prev === next) return next;
  const byKey = new Map(prev.map((n) => [n.key, n]));
  let changed = prev.length !== next.length;
  const out = next.map((n, i) => {
    const p = byKey.get(n.key);
    const r = p ? shareNode(p, n) : n;
    if (r !== prev[i]) changed = true;
    return r;
  });
  return changed ? out : prev;
}

function shareNode(p: ViewNode, n: ViewNode): ViewNode {
  if (same(p, n)) return p;
  const nl = childLists(n);
  if (nl.length === 0 || nodeKind(p) !== nodeKind(n)) return n;
  const pl = childLists(p);
  return withChildLists(
    n,
    nl.map((l, i) => shareNodes(pl[i] ?? [], l)),
  );
}

/** A new view sharing the unchanged nodes of the one before (shareNodes). */
export function shareView(prev: PluginViewModel | null, next: PluginViewModel): PluginViewModel {
  if (!prev) return next;
  const out: PluginViewModel = { ...next };
  for (const list of VIEW_LISTS) {
    const n = next[list];
    const p = prev[list];
    if (n && p) out[list] = shareNodes(p, n) as ViewNode[];
  }
  return out;
}

/** An entry after one update (toasts are side effects: see startSurfaceWatch). Pure. */
export function applySurfaceUpdate(e: SurfaceEntry, u: SurfaceUpdateView): SurfaceEntry {
  switch (u.kind) {
    case "state":
      return { ...e, instance: u.instance || e.instance, phase: u.phase, message: u.message, pluginState: u.pluginState, error: null };
    case "view":
      if (!u.view) return e;
      return { ...e, instance: u.instance || e.instance, version: u.version, view: shareView(e.view, u.view), hostRendered: u.hostRendered, error: null };
    case "append":
      if (!e.view || u.version !== e.version) return e;
      return { ...e, view: appendToView(e.view, u.key, u.text, u.lines) };
    case "toast":
      return e;
  }
}

/** Calls f for every node at any depth with its scope (the nodeScope of the nodes around it, after `scope`), parents first. */
export function walkScoped(nodes: readonly ViewNode[], f: (n: ViewNode, scope: string) => void, scope = ""): void {
  for (const n of nodes) {
    f(n, scope);
    const inner = scope + nodeScope(n);
    for (const l of childLists(n)) walkScoped(l, f, inner);
  }
}

/**
 * Every form in a list of nodes (inside sections, columns, panes, containers, tabs nodes
 * and details too), by key, with its scope below the view tab (draftKeyOf(instance, tab +
 * scope, key)); a view's: formsOf(viewNodes(view)).
 */
export function formsOf(nodes: readonly ViewNode[]): { key: string; form: FormNodeData; scope: string }[] {
  const out: { key: string; form: FormNodeData; scope: string }[] = [];
  walkScoped(nodes, (n, scope) => {
    if (n.form) out.push({ key: n.key, form: n.form, scope });
  });
  return out;
}

/**
 * Drafts after a new view: a form whose resetToken changed loses its drafts (and the new
 * token is recorded). Returns the same objects when nothing changed.
 */
export function reconcileResets(
  drafts: PluginSurfacesState["drafts"],
  tokens: PluginSurfacesState["resetTokens"],
  instance: string,
  view: PluginViewModel,
): Pick<PluginSurfacesState, "drafts" | "resetTokens"> {
  const tab = view.tabs?.active ?? "";
  let d = drafts;
  let t = tokens;
  for (const { key, form, scope } of formsOf(viewNodes(view))) {
    const dk = draftKeyOf(instance, tab + scope, key);
    const token = form.resetToken ?? "";
    const prev = t[dk];
    if (prev === token) continue;
    t = { ...t, [dk]: token };
    if (prev !== undefined && dk in d) {
      const { [dk]: _dropped, ...rest } = d;
      d = rest;
    }
  }
  return { drafts: d, resetTokens: t };
}

/** Whether a form carries the plugin's errors: the form's own, a field's or a fieldset's. */
export function formHasErrors(form: FormNodeData): boolean {
  if (form.error) return true;
  return form.fields.some((f) => Boolean(f.error) || Boolean(f.fieldset?.error) || (f.fieldset?.fields.some((c) => Boolean(c.error)) ?? false));
}

/**
 * Drafts after a view newer than a submit the plugin took: a form the view shows without
 * errors (or no longer shows) loses its drafts; one with errors keeps them. Either way
 * the submit is settled. Returns the same objects when nothing changed.
 */
export function settleSubmits(
  drafts: PluginSurfacesState["drafts"],
  submitted: PluginSurfacesState["submitted"],
  instance: string,
  view: PluginViewModel,
  version: number,
): Pick<PluginSurfacesState, "drafts" | "submitted"> {
  const due = Object.entries(submitted).filter(([dk, v]) => version > v && dk.startsWith(`${instance}\u0000`));
  if (due.length === 0) return { drafts, submitted };
  const tab = view.tabs?.active ?? "";
  const forms = new Map(formsOf(viewNodes(view)).map(({ key, form, scope }) => [draftKeyOf(instance, tab + scope, key), form]));
  let d = drafts;
  const settled = new Set(due.map(([dk]) => dk));
  const sub = Object.fromEntries(Object.entries(submitted).filter(([dk]) => !settled.has(dk)));
  for (const dk of settled) {
    const form = forms.get(dk);
    if (form && formHasErrors(form)) continue;
    if (dk in d) {
      const { [dk]: _dropped, ...rest } = d;
      d = rest;
    }
  }
  return { drafts: d, submitted: sub };
}

/**
 * Narrow master-details after a new view: one showing its detail goes back to its list
 * when its resetToken changed, or its selected row changed to a key that is not a row
 * (nothing selected included); a selected row that changed to another row is recorded.
 * One whose node the view does not show is kept (another view tab may show it again).
 * Returns the same object when nothing changed.
 */
export function reconcileDetails(details: PluginSurfacesState["details"], instance: string, view: PluginViewModel): PluginSurfacesState["details"] {
  const tab = view.tabs?.active ?? "";
  let d = details;
  walkScoped(viewNodes(view), (n, scope) => {
    const md = n.masterDetail;
    if (!md) return;
    const dk = draftKeyOf(instance, tab + scope, n.key);
    const open = d[dk];
    if (!open) return;
    const token = md.resetToken ?? "";
    const selected = md.selected ?? "";
    if (token === open.token && selected === open.selected) return;
    const isRow = (md.list.rows ?? []).some((r) => r.key === selected);
    if (token !== open.token || !isRow) {
      const { [dk]: _gone, ...rest } = d;
      d = rest;
    } else {
      d = { ...d, [dk]: { token, selected } };
    }
  });
  return d;
}

/** Whether any node of the view is of a kind this GUI does not know (shown as a notice). */
export function unknownNodes(nodes: readonly ViewNode[]): string[] {
  return nodes.flatMap((n) => (nodeKind(n) === null ? [n.key] : childLists(n).flatMap((l) => unknownNodes(l))));
}

// ---------------------------------------------------------------------------------------
// Actions

function setEntry(watchKey: string, f: (e: SurfaceEntry) => SurfaceEntry): void {
  usePluginSurfacesStore.setState((s) => {
    const e = s.watches[watchKey];
    if (!e) return s;
    const next = f(e);
    return next === e ? s : { watches: { ...s.watches, [watchKey]: next } };
  });
}

/**
 * The store after one update on a watch (toasts aside): the entry, and for a view the
 * drafts' reset tokens, settled submits, narrow master-details and the answered choices
 * that view shows (endChoices). Pure; the same state when nothing changed.
 */
export function applyUpdateToState(s: PluginSurfacesState, watchKey: string, u: SurfaceUpdateView): PluginSurfacesState {
  const e = s.watches[watchKey];
  if (!e) return s;
  const next = applySurfaceUpdate(e, u);
  if (next === e) return s;
  const watches = { ...s.watches, [watchKey]: next };
  const view = next.view;
  if (u.kind !== "view" || !view) return { ...s, watches };
  const reset = reconcileResets(s.drafts, s.resetTokens, next.instance, view);
  const settled = settleSubmits(reset.drafts, s.submitted, next.instance, view, next.version);
  const out: PluginSurfacesState = { ...s, watches, resetTokens: reset.resetTokens, ...settled, details: reconcileDetails(s.details, next.instance, view) };
  // An answered choice ends with the view that shows it (or no longer shows its chooser);
  // another view may be an older one still on its way (coalesced before the act).
  const done = Object.entries(s.choices[watchKey] ?? {}).flatMap(([k, c]) => {
    if (!c.answered) return [];
    const now = chooserValue(view, next.instance, k);
    return now === undefined || now === c.key ? [k] : [];
  });
  return { ...out, ...endChoices(out, watchKey, done) };
}

function onUpdate(watchKey: string, u: SurfaceUpdateView): void {
  if (u.kind === "toast") {
    if (u.level === "error") toast.error(u.text);
    else if (u.level === "attention") toast.warning(u.text);
    else toast.info(u.text);
    return;
  }
  usePluginSurfacesStore.setState((s) => applyUpdateToState(s, watchKey, u));
}

/**
 * Holds a surface open while its tab shows: WatchSurface with reconnects (a daemon or
 * plugin restart reopens it; the cached view paints first). Returns the stop function,
 * which forgets the watch (drafts and collapsed sections stay with the instance).
 */
export function startSurfaceWatch(watchKey: string, ref: SurfaceRefView): () => void {
  usePluginSurfacesStore.setState((s) => ({ watches: { ...s.watches, [watchKey]: { ...(s.watches[watchKey] ?? emptyEntry(ref)), context: ref.context } } }));
  const stop = runStream<SurfaceUpdateView>({
    open: (signal) => watchSurface(ref, signal),
    slot: { label: `surface:${ref.plugin}.${ref.surface}`, priority: "core" },
    onEvent: (u) => {
      onUpdate(watchKey, u);
    },
    onStatus: (status, err) => {
      if (status === "retrying" || status === "stopped") setEntry(watchKey, (e) => ({ ...e, error: err ?? "the surface's stream ended" }));
    },
    onError: invalidateOnTransportError,
  });
  return () => {
    stop();
    usePluginSurfacesStore.setState((s) => {
      if (!(watchKey in s.watches) && !(watchKey in s.pending) && !(watchKey in s.choices)) return s;
      const { [watchKey]: _w, ...watches } = s.watches;
      const { [watchKey]: _p, ...pending } = s.pending;
      const { [watchKey]: _c, ...choices } = s.choices;
      return { watches, pending, choices };
    });
  };
}

function setPending(watchKey: string, key: string, on: boolean): void {
  usePluginSurfacesStore.setState((s) => {
    const cur = s.pending[watchKey] ?? {};
    if (on === key in cur) return s;
    const { [key]: _was, ...rest } = cur;
    const next: Record<string, true> = on ? { ...rest, [key]: true } : rest;
    return { pending: { ...s.pending, [watchKey]: next } };
  });
}

/** Whether an element's act or command is in flight. */
export function usePending(watchKey: string, key: string): boolean {
  return usePluginSurfacesStore((s) => s.pending[watchKey]?.[key] === true);
}

export interface ActOptions {
  value?: string;
  values?: Readonly<Record<string, FieldValue>>;
  /**
   * The submitted form's draftKey: once the plugin takes the act, its drafts go with the
   * first newer view that shows the form without errors (settleSubmits).
   */
  submitOf?: string;
}

/**
 * Sends an act on an element (by key) of the version on screen to the plugin. Pending
 * from now until the plugin answers; its refusal is toasted. Resolves whether it took it.
 */
export async function actOnElement(watchKey: string, key: string, opts: ActOptions = {}): Promise<boolean> {
  const e = usePluginSurfacesStore.getState().watches[watchKey];
  if (!e?.instance || e.version === 0) return false;
  setPending(watchKey, key, true);
  try {
    await actOnSurface({
      instance: e.instance,
      version: e.version,
      key,
      ...(opts.value !== undefined ? { value: opts.value } : {}),
      ...(opts.values ? { values: opts.values } : {}),
      ...(e.context ? { context: e.context } : {}),
    });
    if (opts.submitOf) markSubmitted(watchKey, opts.submitOf, e.version);
    return true;
  } catch (err) {
    invalidateOnTransportError(err);
    toast.error(errorMessage(err));
    return false;
  } finally {
    setPending(watchKey, key, false);
  }
}

/**
 * How long an answered choice waits for a view that shows it before it ends anyway (a
 * plugin that takes the act and sends nothing new, chooses something else, or answers
 * first and sends the view late): well over the daemon's coalescing (100 ms) and its flood
 * throttle (a view a second). Ending then reconciles (endChoices): a narrow master-detail
 * whose plugin selected another row goes back to its list.
 */
export const CHOICE_HOLD_MS = 5000;

let choiceSeq = 0;

function setChoice(watchKey: string, chooser: string, f: (c: Choice | undefined) => Choice | undefined): void {
  usePluginSurfacesStore.setState((s) => {
    const mine = s.choices[watchKey] ?? {};
    const cur = mine[chooser];
    const next = f(cur);
    if (next === cur) return s;
    const { [chooser]: _was, ...rest } = mine;
    return { choices: { ...s.choices, [watchKey]: next ? { ...rest, [chooser]: next } : rest } };
  });
}

/** Ends the chooser's choice if it is still the one numbered `seq` (endChoices). */
function endChoice(watchKey: string, chooser: string, seq: number): void {
  usePluginSurfacesStore.setState((s) => (s.choices[watchKey]?.[chooser]?.seq === seq ? endChoices(s, watchKey, [chooser]) : s));
}

/**
 * The user chose a tab or row (`key`) of a chooser (chooserKeyOf): sends its act and shows
 * it as chosen (useChoice) from now until, after the answer, a view shows it (at most
 * CHOICE_HOLD_MS), or until the act fails. One rule for the view's tabs, tabs nodes and
 * master-details. A later choice on the same chooser replaces this one, and this
 * act's answer then changes nothing: "superseded". Otherwise "took" or "refused" (toasted;
 * the plugin's own value shows again).
 */
export async function chooseElement(watchKey: string, chooser: string, key: string): Promise<"took" | "refused" | "superseded"> {
  const e = usePluginSurfacesStore.getState().watches[watchKey];
  if (!e?.instance || e.version === 0) return "refused";
  const seq = ++choiceSeq;
  setChoice(watchKey, chooser, () => ({ key, seq, version: e.version, answered: false }));
  const took = await actOnElement(watchKey, key);
  const cur = usePluginSurfacesStore.getState().choices[watchKey]?.[chooser];
  if (cur?.seq !== seq) return "superseded";
  if (!took) {
    setChoice(watchKey, chooser, (c) => (c?.seq === seq ? undefined : c));
    return "refused";
  }
  const now = usePluginSurfacesStore.getState().watches[watchKey];
  if (now?.view && chooserValue(now.view, now.instance, chooser) === key) {
    // The view with the choice came before the answer.
    endChoice(watchKey, chooser, seq);
  } else {
    setChoice(watchKey, chooser, (c) => (c?.seq === seq ? { ...c, answered: true } : c));
    setTimeout(() => {
      endChoice(watchKey, chooser, seq);
    }, CHOICE_HOLD_MS);
  }
  return "took";
}

/** The chooser's choice in flight (a key), or undefined. */
export function useChoice(watchKey: string, chooser: string): string | undefined {
  return usePluginSurfacesStore((s) => s.choices[watchKey]?.[chooser]?.key);
}

/** Runs a command action with the panel's context (its confirm dialog included), pending meanwhile. */
export async function runCommandElement(watchKey: string, key: string, name: string, args: Record<string, string>, ctx: UiContextView): Promise<boolean> {
  setPending(watchKey, key, true);
  try {
    return (await runCommandForResult(name, args, { ctx })) !== null;
  } finally {
    setPending(watchKey, key, false);
  }
}

/** The host's own actions: open a URL, copy text. */
export function openElementUrl(url: string): void {
  void openUrl(url);
}

export async function copyElementText(text: string): Promise<void> {
  await copyText(text);
  toast.success("Copied");
}

export function setDraft(draftKey: string, name: string, value: FieldValue): void {
  usePluginSurfacesStore.setState((s) => ({ drafts: { ...s.drafts, [draftKey]: { ...s.drafts[draftKey], [name]: value } } }));
}

/** Drops one field's draft (Escape: back to the plugin's value). */
export function revertDraft(draftKey: string, name: string): void {
  usePluginSurfacesStore.setState((s) => {
    const cur = s.drafts[draftKey];
    if (!cur || !(name in cur)) return s;
    const { [name]: _gone, ...rest } = cur;
    return { drafts: { ...s.drafts, [draftKey]: rest } };
  });
}

/** Records a submit the plugin took; settles it at once when a newer view is already here. */
function markSubmitted(watchKey: string, draftKey: string, version: number): void {
  usePluginSurfacesStore.setState((s) => {
    const submitted = { ...s.submitted, [draftKey]: version };
    const e = s.watches[watchKey];
    if (!e?.view || e.version <= version) return { submitted };
    return settleSubmits(s.drafts, submitted, e.instance, e.view, e.version);
  });
}

export function clearDrafts(draftKey: string): void {
  usePluginSurfacesStore.setState((s) => {
    if (!(draftKey in s.drafts)) return s;
    const { [draftKey]: _gone, ...drafts } = s.drafts;
    return { drafts };
  });
}

/** A field's draft (undefined while pristine). */
export function useDraft(draftKey: string, name: string): FieldValue | undefined {
  return usePluginSurfacesStore((s) => s.drafts[draftKey]?.[name]);
}

/** The user's collapse toggle of a section, by draftKeyOf(instance, scope, section key) (undefined: the plugin's initial state). */
export function useCollapsed(sectionKey: string): boolean | undefined {
  return usePluginSurfacesStore((s) => s.collapsed[sectionKey]);
}

export function setCollapsed(sectionKey: string, collapsed: boolean): void {
  usePluginSurfacesStore.setState((s) => ({ collapsed: { ...s.collapsed, [sectionKey]: collapsed } }));
}

/** Whether a master-detail (by draftKeyOf(instance, scope, node key)) shows its detail alone in the narrow layout. */
export function useDetailOpen(detailKey: string): boolean {
  return usePluginSurfacesStore((s) => detailKey in s.details);
}

/** The user chose a row: the master-detail shows its detail alone while narrow (until Back, or reconcileDetails). */
export function openDetail(detailKey: string, token: string, selected: string): void {
  usePluginSurfacesStore.setState((s) => ({ details: { ...s.details, [detailKey]: { token, selected } } }));
}

/** Back to the list (or the choice's act failed). */
export function closeDetail(detailKey: string): void {
  usePluginSurfacesStore.setState((s) => {
    if (!(detailKey in s.details)) return s;
    const { [detailKey]: _gone, ...details } = s.details;
    return { details };
  });
}

/** A watch's entry fields, narrowly. */
export function useSurfaceEntry<T>(watchKey: string, pick: (e: SurfaceEntry | undefined) => T): T {
  return usePluginSurfacesStore((s) => pick(s.watches[watchKey]));
}
