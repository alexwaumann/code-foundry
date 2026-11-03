/**
 * The in-thread find bar's state (docs/notes/search-2-thread-find.md), per thread: the
 * query, the current match and what the bar asks of the view. The matches come from the
 * thread's items (lib/threadFind findMatches), so a match in a part of the thread that is
 * not rendered still counts; the thread's find layer (components/thread/find/FindLayer)
 * picks the first current match, scrolls to it and paints what is on screen.
 *
 * A session lives while its thread is in the content pane: leaving the thread forgets it
 * (ThreadPane's WatchedThread), a visit to one of its subagent runs does not.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { findMatches, matchIndex, stepIndex, type FindKey, type FindMatch } from "@/lib/threadFind";
import { getViewing } from "./subagentView";
import { getThreadItems, useThreadStore } from "./thread";
import { useUiStore } from "./ui";

/** Where the next current match is picked when the matches are known (the find layer does it). */
export type FindAim =
  /**
   * The first match at or after `fromItem` (the match that was current while the query
   * was edited: typing on searches on from there, as a browser's find does), else at or
   * below the top of what the list shows (opening).
   */
  | { kind: "view"; fromItem?: string }
  /** The first match in this item (openThreadFind's itemId), else as "view". */
  | { kind: "item"; itemId: string };

export interface FindSession {
  query: string;
  current: FindKey | null;
  /** Set while the current match is still to be picked. */
  aim: FindAim | null;
  /** Bumped when the bar should take the keyboard and select its query (open, cmd+f again). */
  focusSeq: number;
  /** Bumped when the current match should be brought into view again (a step that lands on the same match). */
  revealSeq: number;
}

export interface ThreadFindState {
  byThread: Readonly<Record<string, FindSession>>;
}

export const useThreadFindStore = create<ThreadFindState>()(() => ({ byThread: {} }));

function update(threadId: string, f: (s: FindSession | undefined) => FindSession | undefined): void {
  useThreadFindStore.setState((st) => {
    const next = f(st.byThread[threadId]);
    if (next === st.byThread[threadId]) return st;
    if (!next) {
      const { [threadId]: _gone, ...rest } = st.byThread;
      return { byThread: rest };
    }
    return { byThread: { ...st.byThread, [threadId]: next } };
  });
}

/**
 * Opens a thread's find bar, focused with its query selected. With `query`, the bar
 * searches it, and with `itemId` the first match in that item becomes current (else the
 * first at or below the top of the list): the hand-off for a search that found the item
 * elsewhere. Without, the bar keeps what it had (an empty one opens).
 */
export function openThreadFind(threadId: string, query?: string, opts: { itemId?: string } = {}): void {
  update(threadId, (s) => {
    const base: FindSession = s ?? { query: "", current: null, aim: null, focusSeq: 0, revealSeq: 0 };
    const focusSeq = base.focusSeq + 1;
    if (query === undefined) return { ...base, focusSeq, aim: s ? base.aim : { kind: "view" } };
    return { ...base, query, current: null, aim: opts.itemId !== undefined ? { kind: "item", itemId: opts.itemId } : { kind: "view" }, focusSeq };
  });
}

/** Closes a thread's find bar and forgets its query. */
export function closeThreadFind(threadId: string): void {
  update(threadId, () => undefined);
}

/** The bar's query changed: the current match is picked again, from the last current one's item on (else from what the list shows). */
export function setThreadFindQuery(threadId: string, query: string): void {
  update(threadId, (s) => {
    if (!s) return s;
    const fromItem = s.current?.itemId ?? (s.aim?.kind === "item" ? s.aim.itemId : s.aim?.fromItem);
    return { ...s, query, current: null, aim: fromItem === undefined ? { kind: "view" } : { kind: "view", fromItem } };
  });
}

/** The find layer picked the current match (or none). */
export function setThreadFindCurrent(threadId: string, current: FindKey | null): void {
  update(threadId, (s) => (s ? { ...s, current, aim: null, revealSeq: s.revealSeq + 1 } : s));
}

/** The thread's matches for the session's query, from the items as they are now. */
export function getThreadFindMatches(threadId: string): FindMatch[] {
  const q = useThreadFindStore.getState().byThread[threadId]?.query ?? "";
  return findMatches(getThreadItems(threadId), q);
}

/**
 * Goes to the next (1) or previous (-1) match, wrapping (Enter, shift+Enter, the bar's
 * buttons, cmd+g, cmd+shift+g). With the bar closed it opens instead. False when there was
 * nothing to step to.
 */
export function stepThreadFind(threadId: string, dir: 1 | -1): boolean {
  const s = useThreadFindStore.getState().byThread[threadId];
  if (!s) {
    openThreadFind(threadId);
    return false;
  }
  const matches = getThreadFindMatches(threadId);
  const next = matches[stepIndex(matches.length, matchIndex(matches, s.current), dir)];
  if (!next) return false;
  setThreadFindCurrent(threadId, { itemId: next.itemId, nth: next.nth });
  return true;
}

export function useThreadFindOpen(threadId: string): boolean {
  return useThreadFindStore((s) => threadId in s.byThread);
}

export function useThreadFindQuery(threadId: string): string {
  return useThreadFindStore((s) => s.byThread[threadId]?.query ?? "");
}

export function useThreadFindFocusSeq(threadId: string): number {
  return useThreadFindStore((s) => s.byThread[threadId]?.focusSeq ?? 0);
}

/** The current match's identity (compared by value, so a re-set to the same match does not re-render). */
export function useThreadFindCurrent(threadId: string): FindKey | null {
  const itemId = useThreadFindStore((s) => s.byThread[threadId]?.current?.itemId ?? "");
  const nth = useThreadFindStore((s) => s.byThread[threadId]?.current?.nth ?? -1);
  return useMemo(() => (itemId === "" ? null : { itemId, nth }), [itemId, nth]);
}

export function useThreadFindAim(threadId: string): FindAim | null {
  return useThreadFindStore((s) => s.byThread[threadId]?.aim ?? null);
}

export function useThreadFindRevealSeq(threadId: string): number {
  return useThreadFindStore((s) => s.byThread[threadId]?.revealSeq ?? 0);
}

/**
 * The thread's matches for a query, recounted as its items change (a streaming answer
 * included); each item's text is read once (lib/threadFind findDoc).
 */
export function useThreadFindMatches(threadId: string, query: string): FindMatch[] {
  const log = useThreadStore((s) => (query === "" ? undefined : s.logs[threadId]));
  return useMemo(() => {
    if (!log || query === "") return [];
    return findMatches(log.order.flatMap((id) => (log.byId[id] ? [log.byId[id]] : [])), query);
  }, [log, query]);
}

/**
 * thread.find, thread.find.next and thread.find.previous in this window (keys/bindings.ts,
 * a ShowView from the CLI): on the thread in the content pane (Ember's chat included, not a
 * subagent run's view), open the find bar (focused, its query selected) or step through
 * its matches. True when a thread was there to act on.
 */
export function presentThreadFind(action: "open" | "next" | "previous"): boolean {
  const sel = useUiStore.getState().selection;
  if (sel.kind !== "thread" || getViewing()?.threadId === sel.id) return false;
  if (action === "open") openThreadFind(sel.id);
  else stepThreadFind(sel.id, action === "next" ? 1 : -1);
  return true;
}
