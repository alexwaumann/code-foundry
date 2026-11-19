/**
 * Back and forward through what was focused (docs/notes/shell-model.md, "Keys": cmd+[ and cmd+],
 * across panes and spaces; docs/notes/shell-15-spaces.md). One window's list of
 * (space, pane, tab) entries, oldest first, with browser semantics: a new focus drops the entries
 * after the current one. Per window and not persisted, as the classic window's selection history.
 *
 * What is recorded is the layout's focus as it settles: the current space and its focused pane's
 * active tab. Every way the focus moves goes through the layout (a press on a pane or a tab, the
 * keys, a space switch, the linked row, cmd+shift+d, the terminal ring, a sidebar click), so the
 * recorder follows the layout slice and needs no call from them; changes within one task (a
 * close and the refocus after it, an optimistic focus and its confirmation) count once. Hovering
 * never moves the layout's focus.
 *
 * Going back or forward focuses the entry's tab where it is now (it may have moved), switching
 * space when needed, and skips entries whose tab is gone or that show what is already focused.
 * See docs/notes/shell-15-spaces.md.
 *
 * Under layout.threads_open_as panes or single a thread opened replaces the one its pane showed,
 * so back and forward are the thread history of the pane: an entry of a thread whose tab is gone
 * opens the thread again (thread.open, which replaces in turn), and an entry is that thread's
 * whatever tab id it has now (docs/notes/threads-open-as-1-rules.md).
 */
import { create } from "zustand";
import { runLayoutCommand, focusTabNow } from "@/shell/commands";
import { focusedTab } from "@/stores/selectionBridge";
import { useLayoutStore, type LayoutState } from "@/stores/layout";
import { useSettingsStore } from "@/stores/settings";
import { requestPaneFocus } from "@/stores/shellView";
import { THREADS_OPEN_AS_KEY } from "@/shell/threadsOpenAs";

/** The setting that makes an open replace a thread pane's thread (internal/layout modes.go). */
export { THREADS_OPEN_AS_KEY };

/** Whether a value of layout.threads_open_as replaces: panes and single. */
export function threadsReplace(value: string | undefined): boolean {
  return value === "panes" || value === "single";
}

/** Whether the setting replaces now. */
function replacesNow(): boolean {
  return threadsReplace(useSettingsStore.getState().snapshot?.values[THREADS_OPEN_AS_KEY]);
}

/** One focused place. `tab` is "" for a space with no pane (its home composer). */
export interface FocusEntry {
  space: string;
  pane: string;
  tab: string;
  /** The thread when the tab is a thread's own tab: under panes and single the entry is the thread's. */
  thread?: string;
}

export interface FocusHistoryState {
  entries: readonly FocusEntry[];
  /** The current entry; -1 while empty. */
  index: number;
}

/** How many entries are kept; the oldest go first. */
export const FOCUS_HISTORY_MAX = 100;

const EMPTY: FocusHistoryState = { entries: [], index: -1 };

export const useFocusHistoryStore = create<FocusHistoryState>()(() => EMPTY);

type LayoutView = Pick<LayoutState, "currentSpaceId" | "spaces" | "panes" | "tabs">;

/** What the layout has focused now; null before it loaded or with no space. */
export function focusedEntry(s: LayoutView): FocusEntry | null {
  if (!s.currentSpaceId || !s.spaces[s.currentSpaceId]) return null;
  const tab = focusedTab(s);
  const e: FocusEntry = { space: s.currentSpaceId, pane: tab?.paneId ?? "", tab: tab?.id ?? "" };
  if (tab?.kind === "thread" && tab.thread) e.thread = tab.thread;
  return e;
}

/** One place: the same tab, or the same thread's tab (a thread replaced and opened again has a new tab id). */
function sameEntry(a: FocusEntry | null | undefined, b: FocusEntry | null | undefined): boolean {
  return !!a && !!b && a.space === b.space && (a.tab === b.tab || (!!a.thread && a.thread === b.thread));
}

/** The history with `e` pushed (pure): the entries after the current one dropped, unless `e` is the current one. */
export function pushEntry(h: FocusHistoryState, e: FocusEntry): FocusHistoryState {
  if (sameEntry(h.entries[h.index], e)) return h;
  const entries = [...h.entries.slice(0, h.index + 1), e].slice(-FOCUS_HISTORY_MAX);
  return { entries, index: entries.length - 1 };
}

/**
 * Where an entry's place is now: its tab's space and pane (a tab keeps its id when it moves), or
 * for a space without a tab, that space. Null when the tab or the space is gone. With `reopen`
 * (threads open as panes or single), a thread's entry whose tab is gone is its thread's tab open
 * now, else the thread to open again (tab "").
 */
export function liveEntry(e: FocusEntry, s: Pick<LayoutState, "spaces" | "panes" | "tabs">, reopen = false): FocusEntry | null {
  if (!e.tab && !e.thread) return s.spaces[e.space] ? e : null;
  const tab = e.tab ? s.tabs[e.tab] : undefined;
  const space = tab ? s.panes[tab.paneId]?.spaceId : undefined;
  if (tab && space) return { space, pane: tab.paneId, tab: tab.id, ...(e.thread ? { thread: e.thread } : {}) };
  if (!reopen || !e.thread) return null;
  const open = Object.values(s.tabs).find((t) => t.kind === "thread" && t.thread === e.thread);
  const at = open ? s.panes[open.paneId]?.spaceId : undefined;
  if (open && at) return { space: at, pane: open.paneId, tab: open.id, thread: e.thread };
  return { space: e.space, pane: "", tab: "", thread: e.thread };
}

/**
 * The index back (-1) or forward (1) would go to: the nearest entry that way that is live and is
 * not what is focused now. Null when there is none.
 */
export function stepIndex(h: FocusHistoryState, s: LayoutView, by: 1 | -1, reopen = false): number | null {
  const now = focusedEntry(s);
  for (let i = h.index + by; i >= 0 && i < h.entries.length; i += by) {
    const e = h.entries[i];
    const live = e ? liveEntry(e, s, reopen) : null;
    if (live && !sameEntry(live, now)) return i;
  }
  return null;
}

/** Whether back (-1) or forward (1) would go anywhere; it only reads, so a selector may call it. `reopen`: liveEntry's. */
export function canStepFocus(h: FocusHistoryState, s: LayoutView, by: 1 | -1, reopen = false): boolean {
  return stepIndex(h, s, by, reopen) !== null;
}

/** Whether back (-1) or forward (1) would go anywhere now, under the setting as it is. */
export function canStepFocusNow(by: 1 | -1): boolean {
  return canStepFocus(useFocusHistoryStore.getState(), useLayoutStore.getState(), by, replacesNow());
}

/** Whether back (-1) or forward (1) would go anywhere, following the history, the layout and the setting. */
export function useCanStepFocus(by: 1 | -1): boolean {
  const h = useFocusHistoryStore((x) => x);
  const reopen = useSettingsStore((x) => threadsReplace(x.snapshot?.values[THREADS_OPEN_AS_KEY]));
  return useLayoutStore((s) => canStepFocus(h, s, by, reopen));
}

/** Records what the layout has focused now. */
export function recordFocus(): void {
  const e = focusedEntry(useLayoutStore.getState());
  if (!e) return;
  const h = useFocusHistoryStore.getState();
  const next = pushEntry(h, e);
  if (next !== h) useFocusHistoryStore.setState(next, true);
}

/**
 * Back (-1) or forward (1): focuses the entry's tab, which switches space when it is in another
 * (tab.focus), and moves the keyboard into its pane; a space without a tab is switched to
 * (space.switch). Resolves whether it went anywhere.
 */
export async function stepFocus(by: 1 | -1): Promise<boolean> {
  const s = useLayoutStore.getState();
  const h = useFocusHistoryStore.getState();
  const reopen = replacesNow();
  const i = stepIndex(h, s, by, reopen);
  const e = i === null ? undefined : h.entries[i];
  const live = e ? liveEntry(e, s, reopen) : null;
  if (i === null || !live) return false;
  // The index moves first: the focus the step causes is then the current entry, and is not pushed.
  useFocusHistoryStore.setState({ index: i });
  if (live.tab) {
    const ok = await focusTabNow(live.tab);
    if (ok) requestPaneFocus(live.pane);
    return ok;
  }
  if (live.thread) {
    // Panes and single: the thread opens again, replacing the one its pane shows now.
    return (await runLayoutCommand("thread.open", { id: live.thread, focus: "true" })) !== null;
  }
  return (await runLayoutCommand("space.switch", { space: live.space, focus: "true" })) !== null;
}

/**
 * Starts recording (the shell draws the window): the focus as the layout holds it now, then each
 * change of the current space or its focused tab, once per task. Returns the stop.
 */
export function startFocusHistory(): () => void {
  let queued = false;
  let last = "";
  const key = (s: LayoutView) => {
    const e = focusedEntry(s);
    return e ? `${e.space}/${e.tab}` : "";
  };
  const flush = () => {
    queued = false;
    const k = key(useLayoutStore.getState());
    if (!k || k === last) return;
    last = k;
    recordFocus();
  };
  const unsub = useLayoutStore.subscribe((s) => {
    if (queued || key(s) === last) return;
    queued = true;
    queueMicrotask(flush);
  });
  flush();
  return () => {
    unsub();
  };
}

/** Back to empty (tests; a window that stops drawing the shell). */
export function resetFocusHistory(): void {
  useFocusHistoryStore.setState(EMPTY, true);
}
