/**
 * Plugin surfaces on screen (docs/notes/plugins-5-gui.md): one PluginService.WatchSurface
 * per visible plugin tab (its state, view versions, log appends and toasts), the host's
 * form drafts per instance and view tab, collapsed sections, and the acts in flight.
 *
 * Keys: a watch is per panel tab (`watchKey`: panel key + tab id); drafts and collapsed
 * sections are per instance (the daemon's `<plugin>/<surface>/<scope id>`), so a tab that
 * closes and reopens on the same instance finds them again. Nothing here is persisted.
 */
import { create } from "zustand";
import { toast } from "sonner";
import { invalidateOnTransportError } from "@/api/endpoint";
import {
  actOnSurface,
  nodeKind,
  watchSurface,
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
  /** The user's section toggles, by instance then section key (true: collapsed). */
  collapsed: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  /** Elements whose act or command is in flight, by watch key then element key. */
  pending: Readonly<Record<string, Readonly<Record<string, true>>>>;
}

export const usePluginSurfacesStore = create<PluginSurfacesState>()(() => ({ watches: {}, drafts: {}, resetTokens: {}, collapsed: {}, pending: {} }));

/** A tab's watch key: its panel's key and its id. */
export function watchKeyOf(panelKey: string, tabId: string): string {
  return `${panelKey}\u0000${tabId}`;
}

/** Where a form's drafts live: the instance, the view tab ("" without tabs) and the form's key. */
export function draftKeyOf(instance: string, viewTab: string, formKey: string): string {
  return `${instance}\u0000${viewTab}\u0000${formKey}`;
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
    if (n.section) {
      const children = mapNode(n.section.children, key, f);
      if (children) {
        const out = [...nodes];
        out[i] = { ...n, section: { ...n.section, children } };
        return out;
      }
    }
  }
  return null;
}

/** The view with one log node extended (view/append); the same view when the key names no log. */
export function appendToView(view: PluginViewModel, key: string, text: string, lines: readonly LogLine[]): PluginViewModel {
  const hit = { log: false };
  const nodes = mapNode(view.nodes, key, (n) => {
    if (!n.log) return n;
    hit.log = true;
    return { ...n, log: appendToLog(n.log, text, lines) };
  });
  return nodes && hit.log ? { ...view, nodes } : view;
}

/** An entry after one update (toasts are side effects: see startSurfaceWatch). Pure. */
export function applySurfaceUpdate(e: SurfaceEntry, u: SurfaceUpdateView): SurfaceEntry {
  switch (u.kind) {
    case "state":
      return { ...e, instance: u.instance || e.instance, phase: u.phase, message: u.message, pluginState: u.pluginState, error: null };
    case "view":
      if (!u.view) return e;
      return { ...e, instance: u.instance || e.instance, version: u.version, view: u.view, hostRendered: u.hostRendered, error: null };
    case "append":
      if (!e.view || u.version !== e.version) return e;
      return { ...e, view: appendToView(e.view, u.key, u.text, u.lines) };
    case "toast":
      return e;
  }
}

/** Every form in a view's body (sections included), by key. */
export function formsOf(nodes: readonly ViewNode[]): { key: string; form: FormNodeData }[] {
  return nodes.flatMap((n) => (n.form ? [{ key: n.key, form: n.form }] : n.section ? formsOf(n.section.children) : []));
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
  for (const { key, form } of formsOf(view.nodes)) {
    const dk = draftKeyOf(instance, tab, key);
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

/** Whether any node of the view is of a kind this GUI does not know (shown as a notice). */
export function unknownNodes(nodes: readonly ViewNode[]): string[] {
  return nodes.flatMap((n) => (nodeKind(n) === null ? [n.key] : n.section ? unknownNodes(n.section.children) : []));
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

function onUpdate(watchKey: string, u: SurfaceUpdateView): void {
  if (u.kind === "toast") {
    if (u.level === "error") toast.error(u.text);
    else if (u.level === "attention") toast.warning(u.text);
    else toast.info(u.text);
    return;
  }
  usePluginSurfacesStore.setState((s) => {
    const e = s.watches[watchKey];
    if (!e) return s;
    const next = applySurfaceUpdate(e, u);
    if (next === e) return s;
    const watches = { ...s.watches, [watchKey]: next };
    if (u.kind !== "view" || !next.view) return { watches };
    return { watches, ...reconcileResets(s.drafts, s.resetTokens, next.instance, next.view) };
  });
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
      if (!(watchKey in s.watches) && !(watchKey in s.pending)) return s;
      const { [watchKey]: _w, ...watches } = s.watches;
      const { [watchKey]: _p, ...pending } = s.pending;
      return { watches, pending };
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
  /** Drops this form's drafts once the plugin has taken the act (a submit). */
  clearDraftsOf?: string;
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
    if (opts.clearDraftsOf) clearDrafts(opts.clearDraftsOf);
    return true;
  } catch (err) {
    invalidateOnTransportError(err);
    toast.error(errorMessage(err));
    return false;
  } finally {
    setPending(watchKey, key, false);
  }
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

/** The user's collapse toggle of a section (undefined: the plugin's initial state). */
export function useCollapsed(instance: string, sectionKey: string): boolean | undefined {
  return usePluginSurfacesStore((s) => s.collapsed[instance]?.[sectionKey]);
}

export function setCollapsed(instance: string, sectionKey: string, collapsed: boolean): void {
  usePluginSurfacesStore.setState((s) => ({ collapsed: { ...s.collapsed, [instance]: { ...s.collapsed[instance], [sectionKey]: collapsed } } }));
}

/** A watch's entry fields, narrowly. */
export function useSurfaceEntry<T>(watchKey: string, pick: (e: SurfaceEntry | undefined) => T): T {
  return usePluginSurfacesStore((s) => pick(s.watches[watchKey]));
}
