/**
 * The bottom terminal panel under the content pane (components/bottom), keyed like the
 * side panel (stores/panel.ts keyOf) but only for a thread (`thread:<id>`) and the
 * Projects page (`view:projects`); every other selection has none.
 *
 * Tabs are derived, not stored: a key's tabs are the shells in the terminals store that
 * it owns (bottomTabIds), in the store's order. Per key this store keeps only whether the
 * panel is open, its height, and which terminal was last active. A terminal that goes
 * away (closed, reaped, the daemon restarted) leaves its tab with it. Persisted
 * (localStorage "code-foundry.bottom"); entries are never pruned.
 * See docs/notes/bottom-panel-2-gui.md.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { basename } from "@/lib/path";
import { NO_PROJECT } from "@/lib/threadRow";
import { ACTION_NAME_LABEL, isActionLabels, isPanelLabels, THREAD_LABEL, WORKTREE_LABEL } from "@/lib/termlabel";
import { keyOf } from "./panel";
import { useTerminalsStore, type TerminalsData } from "./terminals";
import { BOTTOM_DEFAULT, useUiStore, type Selection } from "./ui";

export const PROJECTS_KEY = "view:projects";
const THREAD_PREFIX = "thread:";

export interface BottomEntry {
  open: boolean;
  /**
   * Stored height, clamped when it was set. Absent means BOTTOM_DEFAULT. The panel
   * renders at min(height, bottomMax) for the column it is in now.
   */
  height?: number;
  /** The tab last activated. Absent, or no longer a tab: the last tab is active. */
  activeTerminalId?: string;
}

export const emptyBottom: BottomEntry = { open: false };

/** Bottom panel key for a selection: a thread or the Projects page; null for anything else. */
export function bottomKeyOf(sel: Selection): string | null {
  const key = keyOf(sel);
  return key !== null && (key.startsWith(THREAD_PREFIX) || key === PROJECTS_KEY) ? key : null;
}

/** The thread id of a `thread:<id>` key, else null. */
export function threadOfKey(key: string): string | null {
  return key.startsWith(THREAD_PREFIX) ? key.slice(THREAD_PREFIX.length) : null;
}

type LabelledTerminal = { labels: Readonly<Record<string, string>> };

/**
 * The key whose bottom panel shows a terminal: its thread's for a shell or action run a
 * thread owns, the Projects page's for one a worktree owns, null for anything else (an
 * unlabelled terminal from a raw TerminalService.Create, or one labelled without
 * kind=shell or kind=action).
 */
export function ownerKeyOf(t: LabelledTerminal): string | null {
  if (!isPanelLabels(t.labels)) return null;
  const thread = t.labels[THREAD_LABEL];
  return thread ? `${THREAD_PREFIX}${thread}` : PROJECTS_KEY;
}

/** A key's tabs: the ids of the shells and action runs it owns, in the terminals store's order. */
export function bottomTabIds(terminals: TerminalsData, key: string): string[] {
  return terminals.order.filter((id) => {
    const t = terminals.byId[id];
    return t !== undefined && ownerKeyOf(t) === key;
  });
}

/** The active tab: the remembered one while it is still a tab, else the last tab, else null. */
export function activeTabOf(entry: BottomEntry, ids: readonly string[]): string | null {
  const want = entry.activeTerminalId;
  if (want !== undefined && ids.includes(want)) return want;
  return ids[ids.length - 1] ?? null;
}

/**
 * A tab's title. An action run: the action's name when it started (its icon tells it from
 * a shell). On a thread: the terminal's title (OSC) when it has one, else the last
 * segment of its cwd; a thread without a project (`noProject`) names a shell in its home
 * directory (its worktree label) "No project", not after the user's home folder. On the
 * Projects page, where shells of many worktrees share a strip: the worktree's folder name.
 */
export function bottomTabTitle(t: { title: string; cwd: string; labels: Readonly<Record<string, string>> }, key: string, noProject = false): string {
  if (isActionLabels(t.labels)) return t.labels[ACTION_NAME_LABEL] || "Action";
  if (key === PROJECTS_KEY) {
    const wt = t.labels[WORKTREE_LABEL] ?? "";
    return basename(wt || t.cwd);
  }
  if (t.title) return t.title;
  return noProject && t.cwd === (t.labels[WORKTREE_LABEL] ?? "") ? NO_PROJECT : basename(t.cwd);
}

/**
 * Every tab title of a key's panel (bottomTabTitle), with fallback names told apart: the
 * first shell named after a folder (or run of an action) keeps the name, later ones with
 * the same name get " 2", " 3", … in the terminals store's order, so they stay put as
 * tabs come and go after them. A thread's shell with an OSC title shows it as is and takes
 * no number.
 */
export function bottomTabTitles(terminals: TerminalsData, key: string, noProject = false): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Map<string, number>();
  for (const id of bottomTabIds(terminals, key)) {
    const t = terminals.byId[id];
    if (!t) continue;
    if (key !== PROJECTS_KEY && t.title && !isActionLabels(t.labels)) {
      out[id] = t.title;
      continue;
    }
    const name = bottomTabTitle(t, key, noProject);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    out[id] = n === 1 ? name : `${name} ${String(n)}`;
  }
  return out;
}

/** One tab's title as bottomTabTitles numbers it; a primitive, for a narrow selector. */
export function bottomTabTitleOf(terminals: TerminalsData, key: string, id: string, noProject = false): string {
  return bottomTabTitles(terminals, key, noProject)[id] ?? id;
}

/** Shows (true), hides (false) or flips (undefined) the panel. */
export function setOpen(e: BottomEntry, open?: boolean): BottomEntry {
  const next = open ?? !e.open;
  return next === e.open ? e : { ...e, open: next };
}

/** Sets the stored height (already clamped by the caller); undefined drops it, back to BOTTOM_DEFAULT. */
export function setHeight(e: BottomEntry, height: number | undefined): BottomEntry {
  if (e.height === height) return e;
  if (height !== undefined) return { ...e, height };
  const { height: _old, ...rest } = e;
  return rest;
}

/** Remembers the active tab. */
export function activate(e: BottomEntry, id: string): BottomEntry {
  return e.activeTerminalId === id ? e : { ...e, activeTerminalId: id };
}

/** The tab to activate when `id` (a tab of `ids`) goes: the one after it, else the one before. */
export function neighbourOf(ids: readonly string[], id: string): string | null {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/**
 * Whether a key's bottom panel is on screen: there is a key, its panel is open, no
 * settings or usage page covers the content area, and the side panel is not expanded over
 * it. The one rule BottomPanel, visibleBottomKey (stores/views.ts) and
 * toggleBottomCommand share.
 */
export function bottomVisible(key: string | null, open: boolean, pageOpen: boolean, sideExpanded: boolean): key is string {
  return key !== null && open && !pageOpen && !sideExpanded;
}

/** A new shell for this key: show the panel with it active. */
export function openOn(e: BottomEntry, id: string): BottomEntry {
  return activate(setOpen(e, true), id);
}

/** How long a terminal.new this window started may take to show up and still take focus. */
export const PENDING_FOCUS_MS = 10_000;

export interface BottomState {
  byKey: Readonly<Record<string, BottomEntry>>;
  /**
   * Set when terminal.new starts from this window's chord, palette or a CommandButton
   * (keys/bindings.ts), which do not hand back the result: the first new shell for that
   * key within PENDING_FOCUS_MS takes focus. Not persisted.
   */
  pendingFocus: { key: string; at: number } | null;
  /**
   * Set when this window's own terminal.new run ("+", the empty state, a row menu, the
   * Projects rows; stores/bottomActions.ts) returned a shell that has not arrived yet:
   * that shell takes focus when it does, within PENDING_FOCUS_MS. Not persisted.
   */
  pendingFocusId: { id: string; at: number } | null;
  /**
   * Keys whose panel is waiting on a shell this window is starting for it (cmd+j on an
   * empty panel, "+", the empty state; stores/bottomActions.ts openBottomShell), with when
   * it started. While set, an empty panel shows a blank body instead of the empty state,
   * and losing its last tab does not hide it. Not persisted.
   */
  starting: Readonly<Record<string, number>>;
}

export const useBottomStore = create<BottomState>()(
  persist((): BottomState => ({ byKey: {}, pendingFocus: null, pendingFocusId: null, starting: {} }), {
    name: "code-foundry.bottom",
    version: 1,
    partialize: (s) => ({ byKey: s.byKey }),
  }),
);

/** A bottom key, or "current" for the window's selection. */
export type BottomTarget = string;

function resolve(target: BottomTarget): string | null {
  return target === "current" ? bottomKeyOf(useUiStore.getState().selection) : target;
}

/** Applies a reducer to one key's entry. Returns the key, or null when there is none. */
export function updateBottom(target: BottomTarget, f: (e: BottomEntry) => BottomEntry): string | null {
  const key = resolve(target);
  if (key === null) return null;
  useBottomStore.setState((s) => {
    const prev = s.byKey[key] ?? emptyBottom;
    const next = f(prev);
    return next === prev ? s : { byKey: { ...s.byKey, [key]: next } };
  });
  return key;
}

/** The entry for a key (or the current selection); a fresh closed one if it has none. */
export function getBottom(target: BottomTarget = "current"): BottomEntry {
  const key = resolve(target);
  return key === null ? emptyBottom : (useBottomStore.getState().byKey[key] ?? emptyBottom);
}

/** A key's tabs right now (read imperatively). */
export function getBottomTabIds(key: string): string[] {
  return bottomTabIds(useTerminalsStore.getState(), key);
}

/** A key's active tab right now (read imperatively). */
export function getBottomActiveId(key: string): string | null {
  return activeTabOf(getBottom(key), getBottomTabIds(key));
}

/** Asks the visible bottom panel to take focus (its active terminal, else the panel). */
export function requestBottomFocus(): void {
  useUiStore.setState((s) => ({ bottomFocusSeq: s.bottomFocusSeq + 1 }));
}

/**
 * Shows or hides a key's panel (default: the current selection). With `focus`, showing it
 * asks the panel to take focus, after the state change so the panel is mounted by then.
 * Returns the new open state (false when there is no key).
 */
export function toggleBottom(target: BottomTarget = "current", open?: boolean, opts: { focus?: boolean } = {}): boolean {
  const key = updateBottom(target, (e) => setOpen(e, open));
  const now = key !== null && (useBottomStore.getState().byKey[key]?.open ?? false);
  if (now && opts.focus) requestBottomFocus();
  return now;
}

export function activateBottomTab(target: BottomTarget, id: string): void {
  updateBottom(target, (e) => activate(e, id));
}

/** Stores one panel's height (the caller clamps it to the column it renders in). */
export function setBottomHeight(target: BottomTarget, h: number): void {
  updateBottom(target, (e) => setHeight(e, Math.round(h)));
}

/** Puts one panel back at BOTTOM_DEFAULT (drops its stored height). */
export function resetBottomHeight(target: BottomTarget): void {
  updateBottom(target, (e) => setHeight(e, undefined));
}

/** Marks that this window just started terminal.new for `key` (see BottomState.pendingFocus). */
export function markPendingFocus(key: string | null, now = Date.now()): void {
  useBottomStore.setState({ pendingFocus: key === null ? null : { key, at: now } });
}

/** Consumes the pending focus when it is for `key` and recent enough. */
export function takePendingFocus(key: string, now = Date.now()): boolean {
  const p = useBottomStore.getState().pendingFocus;
  if (p?.key !== key || now - p.at > PENDING_FOCUS_MS) return false;
  useBottomStore.setState({ pendingFocus: null });
  return true;
}

/** Marks that this window's terminal.new run returned shell `id`, which has not arrived yet. */
export function markPendingFocusId(id: string | null, now = Date.now()): void {
  useBottomStore.setState({ pendingFocusId: id === null ? null : { id, at: now } });
}

/** Consumes the pending focus when it is for shell `id` and recent enough. */
export function takePendingFocusId(id: string, now = Date.now()): boolean {
  const p = useBottomStore.getState().pendingFocusId;
  if (p?.id !== id || now - p.at > PENDING_FOCUS_MS) return false;
  useBottomStore.setState({ pendingFocusId: null });
  return true;
}

/** Marks that this window is starting a shell for `key`'s panel (see BottomState.starting). */
export function markStarting(key: string, now = Date.now()): void {
  useBottomStore.setState((s) => ({ starting: { ...s.starting, [key]: now } }));
}

/** The shell for `key` arrived, failed, or took too long. `at`: only the start marked then. */
export function clearStarting(key: string, at?: number): void {
  useBottomStore.setState((s) => {
    const was = s.starting[key];
    if (was === undefined || (at !== undefined && was !== at)) return s;
    const { [key]: _done, ...rest } = s.starting;
    return { starting: rest };
  });
}

/** Whether this window is starting a shell for `key` and it is recent enough to wait for. */
export function isStarting(key: string, now = Date.now()): boolean {
  const at = useBottomStore.getState().starting[key];
  return at !== undefined && now - at <= PENDING_FOCUS_MS;
}

/**
 * The open panels that have no tab and are not waiting on a shell: what is left after a
 * daemon restart pruned every shell (the reconnect's List removes terminals without
 * `removed` events), or a persisted open state for a key whose shells are gone.
 */
export function emptyOpenKeys(byKey: Readonly<Record<string, BottomEntry>>, terminals: TerminalsData, starting: Readonly<Record<string, number>> = {}): string[] {
  return Object.keys(byKey).filter((key) => byKey[key]?.open === true && !(key in starting) && bottomTabIds(terminals, key).length === 0);
}

/**
 * The shell the keyboard is in (or the palette returns to): the current key's active tab
 * while focus is in its open bottom panel, else "". The command context's terminal then
 * (stores/context.ts), so Close Terminal and friends act on it.
 */
export function focusedBottomShell(
  ui: { selection: Selection; focus: string; palette: { open: boolean; returnTo: string } },
  terminals: TerminalsData,
  byKey: Readonly<Record<string, BottomEntry>>,
): string {
  const region = ui.palette.open ? ui.palette.returnTo : ui.focus;
  if (region !== "bottom") return "";
  const key = bottomKeyOf(ui.selection);
  const entry = key === null ? undefined : byKey[key];
  if (key === null || !entry?.open) return "";
  return activeTabOf(entry, bottomTabIds(terminals, key)) ?? "";
}

/** The current selection's bottom key (a string, so the selector is cheap and stable). */
export function useCurrentBottomKey(): string | null {
  return useUiStore((s) => bottomKeyOf(s.selection));
}

/** Whether a key's panel is open (false for no key). */
export function useBottomOpen(key: string | null): boolean {
  return useBottomStore((s) => (key === null ? false : (s.byKey[key]?.open ?? false)));
}

/** A key's stored height (BOTTOM_DEFAULT when it has none); not yet bounded by bottomMax. */
export function useBottomHeight(key: string): number {
  return useBottomStore((s) => s.byKey[key]?.height ?? BOTTOM_DEFAULT);
}

/** Whether this window is starting a shell for a key's panel (BottomState.starting). */
export function useBottomStarting(key: string): boolean {
  return useBottomStore((s) => key in s.starting);
}

/** A key's tab ids; shallow-stable, so unrelated terminal updates do not re-render. */
export function useBottomTabIds(key: string): string[] {
  return useTerminalsStore(useShallow((s) => bottomTabIds(s, key)));
}

/** A key's active tab (activeTabOf over its tabs). */
export function useBottomActiveId(key: string): string | null {
  const ids = useBottomTabIds(key);
  const remembered = useBottomStore((s) => s.byKey[key]?.activeTerminalId);
  return activeTabOf(remembered === undefined ? emptyBottom : { open: true, activeTerminalId: remembered }, ids);
}
