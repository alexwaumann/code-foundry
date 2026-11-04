/**
 * The in-thread find bar's state (docs/notes/search-2-thread-find.md), per thread: the
 * query, the current match and what the bar asks of the view. The matches come from the
 * thread's items (lib/threadFind findMatches), so a match in a part of the thread that is
 * not rendered still counts; the thread's find layer (components/thread/find/FindLayer)
 * picks the first current match, scrolls to it and paints what is on screen.
 *
 * A session lives while its thread is in the content pane: leaving the thread forgets it
 * (holdThreadPane, from ThreadPane's WatchedThread), a visit to one of its subagent runs
 * does not.
 *
 * The session also holds what the current match opened (a folded question's row and turn,
 * Ember's work row, a long message's fold) so closing it puts that back at once, before anything else forgets
 * the thread's fold choices.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { findDoc, findMatches, matchIndex, stepIndex, type FindKey, type FindMatch, type FindPlace } from "@/lib/threadFind";
import { getTimeline } from "./cite";
import { getViewing } from "./subagentView";
import { forgetTurnView, getTurnView, messageFoldKey, putTurnView, setRowExpanded, useThreadStore, type ThreadLog, type TurnView } from "./thread";
import { useUiStore } from "./ui";

/** Where the next current match is picked when the matches are known (the find layer does it). */
export type FindAim =
  /**
   * The first match at or after `from` (the match that was current while the query was
   * edited, its item and offset: typing on searches on from there, as a browser's find
   * does), else at or below the top of what the list shows (opening).
   */
  | { kind: "view"; from?: FindPlace }
  /** The first match in this item (openThreadFind's itemId), else as "view". */
  | { kind: "item"; itemId: string };

/** A fold or expand choice the find changed: the value before (undefined: none) and the one it set. */
export interface OpenedChoice {
  before: boolean | undefined;
  set: boolean | undefined;
}

/** What the current match opened, by turn key (folds) and row key (expanded). */
export interface Opened {
  itemId: string;
  folds: Readonly<Record<string, OpenedChoice>>;
  expanded: Readonly<Record<string, OpenedChoice>>;
}

export interface FindSession {
  query: string;
  current: FindKey | null;
  /** Set while the current match is still to be picked. */
  aim: FindAim | null;
  /** Bumped when the bar should take the keyboard and select its query (open, cmd+f again). */
  focusSeq: number;
  /** Bumped when the current match should be brought into view (a pick or a step, also onto the same match). */
  revealSeq: number;
  /** What the current match's item opened, to put back (openThreadFindItem). */
  opened: Opened | null;
  /**
   * Where the last edit of the query went on from (the then current match's item and
   * offset). It outlives a null current: an edit through "no match" (a letter typed, then
   * Backspace) goes on from the same place, not from the top.
   */
  anchor?: FindPlace;
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
    const base: FindSession = s ?? { query: "", current: null, aim: null, focusSeq: 0, revealSeq: 0, opened: null };
    const focusSeq = base.focusSeq + 1;
    if (query === undefined) return { ...base, focusSeq, aim: s ? base.aim : { kind: "view" } };
    const { anchor: _anchor, ...rest } = base;
    return { ...rest, query, current: null, aim: opts.itemId !== undefined ? { kind: "item", itemId: opts.itemId } : { kind: "view" }, focusSeq };
  });
}

/** How many content-pane views hold each thread (holdThreadPane). */
const paneHolds = new Map<string, number>();

/**
 * The thread is in the content pane until the returned release runs. When the last holder
 * releases, a tick later and only if no view took the thread again, its find closes (what
 * it opened is put back) and then its fold choices are forgotten. The tick is for React's
 * StrictMode, which runs an effect's cleanup and the effect again on mount: a hand-off
 * (openThreadFind before the thread is selected) survives that replay.
 */
export function holdThreadPane(threadId: string): () => void {
  paneHolds.set(threadId, (paneHolds.get(threadId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (paneHolds.get(threadId) ?? 1) - 1;
    if (n > 0) {
      paneHolds.set(threadId, n);
      return;
    }
    paneHolds.delete(threadId);
    window.setTimeout(() => {
      if (paneHolds.has(threadId)) return;
      // The find first: what it opened is put back before the choices go.
      closeThreadFind(threadId);
      forgetTurnView(threadId);
    }, 0);
  };
}

/** Closes a thread's find bar and forgets its query; what it opened is put back first, in the same tick. */
export function closeThreadFind(threadId: string): void {
  putBackThreadFind(threadId);
  counted.delete(threadId);
  update(threadId, () => undefined);
}

/**
 * The bar's query changed: the current match is picked again, from the last current one on
 * (else from where the last edit went on from, the anchor, else from what the list shows).
 */
export function setThreadFindQuery(threadId: string, query: string): void {
  const s = useThreadFindStore.getState().byThread[threadId];
  if (!s) return;
  let from: FindPlace | undefined;
  if (s.current) {
    // The current match's offset under the old query: the new one goes on from there.
    const matches = getThreadFindMatches(threadId);
    const m = matches[matchIndex(matches, s.current)];
    from = { itemId: s.current.itemId, start: m?.start ?? 0 };
  } else if (s.aim?.kind === "item") from = { itemId: s.aim.itemId, start: 0 };
  else from = s.aim?.from ?? s.anchor;
  update(threadId, (cur) => {
    if (!cur) return cur;
    if (from === undefined) return { ...cur, query, current: null, aim: { kind: "view" } };
    return { ...cur, query, current: null, aim: { kind: "view", from }, anchor: from };
  });
}

/** The find layer picked the current match (or none). `reveal: false`: the match is not brought into view (a re-pick as text streams). */
export function setThreadFindCurrent(threadId: string, current: FindKey | null, opts: { reveal?: boolean } = {}): void {
  const reveal = opts.reveal ?? true;
  update(threadId, (s) => (s ? { ...s, current, aim: null, revealSeq: reveal ? s.revealSeq + 1 : s.revealSeq } : s));
}

/** The last matches counted per thread: the bar, the layer and a step share them (one count per log and query). */
const counted = new Map<string, { log: ThreadLog; query: string; matches: FindMatch[] }>();

/** A thread's matches for a query in its log as given; counted once per log and query. */
export function threadFindMatches(threadId: string, log: ThreadLog, query: string): FindMatch[] {
  const hit = counted.get(threadId);
  if (hit?.log === log && hit.query === query) return hit.matches;
  const matches = findMatches(
    log.order.flatMap((id) => (log.byId[id] ? [log.byId[id]] : [])),
    query,
  );
  counted.set(threadId, { log, query, matches });
  return matches;
}

/** The thread's matches for the session's query, from the items as they are now. */
export function getThreadFindMatches(threadId: string): FindMatch[] {
  const q = useThreadFindStore.getState().byThread[threadId]?.query ?? "";
  const log = useThreadStore.getState().logs[threadId];
  return log && q !== "" ? threadFindMatches(threadId, log, q) : [];
}

/** Set while the find writes fold choices itself, so the watch below does not take them for the user's. */
let writing = false;

function ownWrite(f: () => void): void {
  writing = true;
  try {
    f();
  } finally {
    writing = false;
  }
}

function changed(before: Readonly<Record<string, boolean>>, after: Readonly<Record<string, boolean>>): Record<string, OpenedChoice> {
  const out: Record<string, OpenedChoice> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[k] !== after[k]) out[k] = { before: before[k], set: after[k] };
  return out;
}

/** Each choice's value before, for the choices the store still holds as the find set them (one the user changed since stays theirs). */
function restore(choices: Readonly<Record<string, OpenedChoice>>, now: Readonly<Record<string, boolean>>): Record<string, boolean | undefined> {
  const out: Record<string, boolean | undefined> = {};
  for (const [k, c] of Object.entries(choices)) if (now[k] === c.set) out[k] = c.before;
  return out;
}

function putBackOpened(threadId: string, opened: Opened | null): void {
  if (!opened) return;
  const now: TurnView = getTurnView(threadId);
  ownWrite(() => {
    putTurnView(threadId, restore(opened.folds, now.folds), restore(opened.expanded, now.expanded));
  });
}

/** Puts back what the current match opened (the match left its item, the query found nothing, the bar closes). */
export function putBackThreadFind(threadId: string): void {
  const s = useThreadFindStore.getState().byThread[threadId];
  if (!s?.opened) return;
  putBackOpened(threadId, s.opened);
  update(threadId, (cur) => (cur ? { ...cur, opened: null } : cur));
}

/**
 * Opens what hides an item for the current match in it, after putting back what the last
 * item opened: a question's row expands (its detail holds the text) and the fold around
 * it opens (a thread's folded turn, Ember's work row; TimelineHandle.unfold). All in one
 * tick and from the store, not the rows on screen, so a choice both need is never toggled
 * on screen. What it changed is kept in the session; nothing again for the same item.
 */
export function openThreadFindItem(threadId: string, itemId: string): void {
  const s = useThreadFindStore.getState().byThread[threadId];
  if (!s || s.opened?.itemId === itemId) return;
  putBackOpened(threadId, s.opened);
  const it = useThreadStore.getState().logs[threadId]?.byId[itemId];
  const kind = it ? findDoc(it)?.kind : undefined;
  const before = getTurnView(threadId);
  ownWrite(() => {
    if (kind === "question") setRowExpanded(threadId, itemId, true);
    getTimeline(threadId)?.unfold?.(itemId);
  });
  const after = getTurnView(threadId);
  const opened: Opened = { itemId, folds: changed(before.folds, after.folds), expanded: changed(before.expanded, after.expanded) };
  update(threadId, (cur) => (cur ? { ...cur, opened } : cur));
}

/**
 * The current match is in the part of a long user message its fold hides (the find layer
 * sees that once the row renders): the message opens, and goes back with the rest of what
 * its item opened. Nothing for a message the user opened: it stays theirs.
 */
export function openThreadFindMessage(threadId: string, itemId: string): void {
  const s = useThreadFindStore.getState().byThread[threadId];
  const key = messageFoldKey(itemId);
  const before = getTurnView(threadId).expanded[key];
  if (s?.opened?.itemId !== itemId || before === true) return;
  ownWrite(() => {
    setRowExpanded(threadId, key, true);
  });
  update(threadId, (cur) => (cur?.opened ? { ...cur, opened: { ...cur.opened, expanded: { ...cur.opened.expanded, [key]: { before, set: true } } } } : cur));
}

// A change by the user (or the timeline) to any choice the find opened for the current
// item, while the bar is open, makes the whole item theirs: nothing of it is put back (the
// turn's fold included: collapsing the question's row and expanding it again must not have
// the find fold the turn over it later), even if a choice later holds the find's value again.
useThreadStore.subscribe((st, prev) => {
  if (writing || (st.folds === prev.folds && st.expanded === prev.expanded)) return;
  for (const [threadId, s] of Object.entries(useThreadFindStore.getState().byThread)) {
    const o = s.opened;
    if (!o) continue;
    const moved = (choices: Readonly<Record<string, OpenedChoice>>, now: Readonly<Record<string, boolean>> | undefined) =>
      Object.entries(choices).some(([k, c]) => now?.[k] !== c.set);
    if (!moved(o.folds, st.folds[threadId]) && !moved(o.expanded, st.expanded[threadId])) continue;
    // The item stays recorded (openThreadFindItem opens nothing again for it), with nothing to put back.
    update(threadId, (cur) => (cur ? { ...cur, opened: { itemId: o.itemId, folds: {}, expanded: {} } } : cur));
  }
});

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

const NO_MATCHES: FindMatch[] = [];
const LOADED = "loaded";

/**
 * The thread's matches for a query, recounted as its items change (a streaming answer
 * included; each item's text is read once, lib/threadFind findDoc) and shared by every
 * caller (threadFindMatches). Null while the thread's log has not loaded.
 */
export function useThreadFindMatches(threadId: string, query: string): FindMatch[] | null {
  // Without a query only whether the log is there matters: no re-render per streaming delta.
  const log = useThreadStore((s) => (query === "" ? (threadId in s.logs ? LOADED : undefined) : s.logs[threadId]));
  return useMemo(() => {
    if (!log) return null;
    return log === LOADED ? NO_MATCHES : threadFindMatches(threadId, log, query);
  }, [threadId, log, query]);
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
