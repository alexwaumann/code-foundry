/**
 * The bottom terminal panel under the content pane (components/bottom), keyed like the
 * side panel (stores/panel.ts keyOf) but only for a thread (`session:<id>`) and the
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
import { isShellLabels, SESSION_LABEL, WORKTREE_LABEL } from "@/lib/termlabel";
import { keyOf } from "./panel";
import { useTerminalsStore, type TerminalsData } from "./terminals";
import { BOTTOM_DEFAULT, useUiStore, type Selection } from "./ui";

export const PROJECTS_KEY = "view:projects";
const SESSION_PREFIX = "session:";

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
  return key !== null && (key.startsWith(SESSION_PREFIX) || key === PROJECTS_KEY) ? key : null;
}

/** The thread id of a `session:<id>` key, else null. */
export function sessionOfKey(key: string): string | null {
  return key.startsWith(SESSION_PREFIX) ? key.slice(SESSION_PREFIX.length) : null;
}

type LabelledTerminal = { labels: Readonly<Record<string, string>> };

/**
 * The key whose bottom panel shows a terminal: its thread's for a shell a thread owns,
 * the Projects page's for a shell a worktree owns, null for anything that is no shell
 * (a thread's Claude terminal, an unlabelled terminal).
 */
export function ownerKeyOf(t: LabelledTerminal): string | null {
  if (!isShellLabels(t.labels)) return null;
  const session = t.labels[SESSION_LABEL];
  return session ? `${SESSION_PREFIX}${session}` : PROJECTS_KEY;
}

/** A key's tabs: the ids of the shells it owns, in the terminals store's order. */
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
 * A tab's title. On a thread: the terminal's title (OSC) when it has one, else the last
 * segment of its cwd. On the Projects page, where shells of many worktrees share a strip:
 * the worktree's folder name.
 */
export function bottomTabTitle(t: { title: string; cwd: string; labels: Readonly<Record<string, string>> }, key: string): string {
  if (key === PROJECTS_KEY) {
    const wt = t.labels[WORKTREE_LABEL] ?? "";
    return basename(wt || t.cwd);
  }
  return t.title || basename(t.cwd);
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

/** A new shell for this key: show the panel with it active. */
export function openOn(e: BottomEntry, id: string): BottomEntry {
  return activate(setOpen(e, true), id);
}

/** How long a terminal.new this window started may take to show up and still take focus. */
export const PENDING_FOCUS_MS = 10_000;

export interface BottomState {
  byKey: Readonly<Record<string, BottomEntry>>;
  /**
   * Set when this window starts terminal.new (stores/bottomActions.ts) for a key: the
   * first new shell for that key within PENDING_FOCUS_MS takes focus. Not persisted.
   */
  pendingFocus: { key: string; at: number } | null;
}

export const useBottomStore = create<BottomState>()(
  persist((): BottomState => ({ byKey: {}, pendingFocus: null }), {
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
