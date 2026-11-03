import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { matchIndex, matchRows, nearestInItem, rowOrder, startIndex, warmFind, type FindKey, type FindMatch, type FindPlace } from "@/lib/threadFind";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { getTimeline } from "@/stores/cite";
import { getThreadItems, useThreadStore } from "@/stores/thread";
import {
  openThreadFindItem,
  putBackThreadFind,
  setThreadFindCurrent,
  useThreadFindAim,
  useThreadFindCurrent,
  useThreadFindMatches,
  useThreadFindOpen,
  useThreadFindQuery,
  useThreadFindRevealSeq,
  type FindAim,
} from "@/stores/threadFind";
import { highlightsSupported } from "../cite/citeDom";
import { clearMatches, paintedKey, paintMatches, revealMatch, timelineIn } from "./findDom";
import "./find.css";

/**
 * The in-thread find's layer over a thread body (docs/notes/search-2-thread-find.md): it
 * picks the current match when the query changes (the first at or below the top of the
 * list, or the item a hand-off named), brings each new current match into view (opening a
 * folded question and putting it back when the match moves on or the bar closes), paints
 * the matches on the rows that render (again as rows mount and text streams in), and
 * draws the match map, a tick per match along the list's scrollbar. Nothing while the
 * thread's find bar is closed.
 */
export function FindLayer({ threadId, paneRef }: { threadId: string; paneRef: RefObject<HTMLElement | null> }) {
  const open = useThreadFindOpen(threadId);
  return open ? <Layer threadId={threadId} paneRef={paneRef} /> : null;
}

/** A tick of the match map: where it sits (a fraction of the list's height) and whether it is the current match's. */
interface Tick {
  at: number;
  current: boolean;
}

function Layer({ threadId, paneRef }: { threadId: string; paneRef: RefObject<HTMLElement | null> }) {
  const query = useThreadFindQuery(threadId);
  const loaded = useThreadFindMatches(threadId, query);
  const matches = loaded ?? NO_MATCHES;
  const current = useThreadFindCurrent(threadId);
  const aim = useThreadFindAim(threadId);
  const revealSeq = useThreadFindRevealSeq(threadId);
  const [ticks, setTicks] = useState<readonly Tick[]>([]);
  const latest = useRef({ query, matches, current });
  useLayoutEffect(() => {
    latest.current = { query, matches, current };
  });
  // Where the current match was in the last count it was in: a re-pick when it went away stays near it.
  const lastPlace = useRef<FindPlace | null>(null);

  // Pick the current match: when the query changed (or a hand-off named an item), and when
  // the current one went away (its item changed under it). Not before the log has loaded:
  // the aim (a hand-off's item) waits for it.
  useEffect(() => {
    if (!loaded) return;
    const at = matchIndex(loaded, current);
    if (current && at >= 0) {
      lastPlace.current = { itemId: current.itemId, start: loaded[at]?.start ?? 0 };
      if (!aim) return;
    }
    if (!aim && !current) return;
    if (loaded.length === 0) {
      setThreadFindCurrent(threadId, null);
      return;
    }
    const pick = pickCurrent(threadId, loaded, aim, current ? lastPlace.current : null);
    const m = loaded[pick.index];
    setThreadFindCurrent(threadId, m ? { itemId: m.itemId, nth: m.nth } : null, { reveal: pick.reveal });
  }, [threadId, aim, loaded, current]);

  // Read the thread's texts ahead in idle slices, so the first keystroke counts without parsing them all.
  useEffect(() => idleWarm(threadId), [threadId]);

  // Paint what renders; again when rows mount or text changes (one frame later), and, for
  // the overlay fallback, as the list scrolls (Custom Highlights move with their text).
  // The ticks follow the same refresh.
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    const pane = paneRef.current;
    const scroller = pane ? timelineIn(pane) : null;
    if (!pane || !scroller) return;
    let raf = 0;
    const run = () => {
      raf = 0;
      const l = latest.current;
      const painted = paintMatches(scroller, l.query, l.current);
      setTicks((prev) => {
        const next = ticksOf(threadId, l.matches, l.current, scroller, painted);
        return sameTicks(prev, next) ? prev : next;
      });
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(run);
    };
    refresh.current = schedule;
    const mo = new MutationObserver(schedule);
    mo.observe(scroller, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(scroller);
    // A tick's place is in the list's own coordinates, so a scroll alone moves none.
    const onScroll = !highlightsSupported();
    if (onScroll) scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
      if (onScroll) scroller.removeEventListener("scroll", schedule);
      refresh.current = () => undefined;
      clearMatches();
    };
  }, [threadId, paneRef]);
  useEffect(() => {
    refresh.current();
  }, [query, matches, current]);

  // A new current match: open what hides it (the store puts back what the last one opened,
  // in the same tick, and again when the bar closes). No current match and none to be
  // picked (the query found nothing): put back. A query being typed keeps what is open
  // until its first match is picked (the same question again, often): putting it back
  // first would fold and unfold it on screen.
  useEffect(() => {
    if (current) openThreadFindItem(threadId, current.itemId);
    else if (!aim) putBackThreadFind(threadId);
  }, [threadId, current, aim]);

  // Bring the current match into view on each pick or step (revealSeq), not when a re-pick
  // as text streams keeps it in place; a reveal under way stops when the match changes.
  const revealed = useRef(-1);
  useEffect(() => {
    const pane = paneRef.current;
    if (!current || !pane || revealed.current === revealSeq) return;
    revealed.current = revealSeq;
    let live = true;
    void revealMatch(threadId, pane, current, latest.current.query, () => live).then(() => {
      if (live) refresh.current();
    });
    return () => {
      live = false;
      // Cut short: the same seq reveals again when the effect runs next.
      revealed.current = -1;
    };
  }, [threadId, paneRef, current, revealSeq]);
  // Off screen (a visit to a subagent run): put back; the current match opens again on return.
  useEffect(
    () => () => {
      putBackThreadFind(threadId);
    },
    [threadId],
  );

  return <MatchMap ticks={ticks} />;
}

const NO_MATCHES: FindMatch[] = [];

/**
 * The current match to pick (`aim` set: a new query or a hand-off; else the current one
 * went away). A hand-off's item, else on from where the last current match was (an edited
 * query), else the top of the list. A current match whose text changed under it (a
 * streaming answer) moves to the nearest match in its item, in place (no reveal); out of
 * its item, on to the next one after it.
 */
function pickCurrent(threadId: string, matches: readonly FindMatch[], aim: FindAim | null, last: FindPlace | null): { index: number; reveal: boolean } {
  const log = useThreadStore.getState().logs[threadId];
  const order = new Map((log?.order ?? []).map((id, i) => [id, i]));
  if (aim) {
    const from = aim.kind === "view" ? aim.from : undefined;
    const fromOrder = from && order.has(from.itemId) ? undefined : topOrder(threadId, order);
    return { index: startIndex(matches, order, { ...(aim.kind === "item" && { itemId: aim.itemId }), ...(from && { from }), ...(fromOrder !== undefined && { fromOrder }) }), reveal: true };
  }
  if (last) {
    const near = nearestInItem(matches, last.itemId, last.start);
    if (near >= 0) return { index: near, reveal: false };
    if (order.has(last.itemId)) return { index: startIndex(matches, order, { from: last }), reveal: true };
  }
  return { index: startIndex(matches, order, { fromOrder: topOrder(threadId, order) }), reveal: true };
}

/** Reads a thread's searchable texts in idle slices (lib/threadFind warmFind) until done or stopped. */
function idleWarm(threadId: string): () => void {
  let i = 0;
  let handle = 0;
  const idle = typeof requestIdleCallback === "function";
  const step = () => {
    const items = getThreadItems(threadId);
    i = warmFind(items, i, 8);
    if (i < items.length) handle = idle ? requestIdleCallback(step, { timeout: 200 }) : window.setTimeout(step, 0);
  };
  // WebKit has no requestIdleCallback: a timer slice each turn of the loop.
  handle = idle ? requestIdleCallback(step, { timeout: 200 }) : window.setTimeout(step, 0);
  return () => {
    if (idle) cancelIdleCallback(handle);
    else window.clearTimeout(handle);
  };
}

/** The log order of the first item at or below the list's top edge (where a new query starts). */
function topOrder(threadId: string, order: ReadonlyMap<string, number>): number {
  const tl = getTimeline(threadId);
  if (!tl) return 0;
  const keys = tl.rowKeys();
  for (let i = tl.topRow(); i < keys.length; i++) {
    const o = rowOrder(keys[i] ?? "", order);
    if (o !== undefined) return o;
  }
  return order.size;
}

/**
 * The match map's ticks, one per spot: a painted match where its text is in the list, any
 * other at its row's place (measured, else estimated).
 */
function ticksOf(threadId: string, matches: readonly FindMatch[], current: FindKey | null, scroller: HTMLElement, painted: ReadonlyMap<string, Range>): Tick[] {
  const tl = getTimeline(threadId);
  const total = scroller.scrollHeight;
  if (!tl || total <= 0 || matches.length === 0) return [];
  const order = useThreadStore.getState().logs[threadId]?.order ?? [];
  const rows = matchRows(order, tl.rowKeys(), matches);
  const spots = new Map<number, Tick>();
  // Client rects are in zoomed px (lib/zoom), offsets in the list in CSS px.
  const z = zoomFactor();
  const top = scroller.getBoundingClientRect().top;
  matches.forEach((m, i) => {
    const range = painted.get(paintedKey(m));
    const offset = range ? scroller.scrollTop + (range.getBoundingClientRect().top - top) / z : (tl.rowStart(rows[i] ?? 0) ?? 0);
    const at = Math.max(0, Math.min(1, offset / total));
    const isCurrent = current?.itemId === m.itemId && current.nth === m.nth;
    // One tick per spot (a quarter of a percent): the current one wins its spot.
    const spot = Math.round(at * 400);
    if (isCurrent || !spots.has(spot)) spots.set(spot, { at, current: isCurrent });
  });
  return [...spots.values()];
}

function sameTicks(a: readonly Tick[], b: readonly Tick[]): boolean {
  return a.length === b.length && a.every((t, i) => t.at === b[i]?.at && t.current === b[i].current);
}

/** The match map: ticks along the list's scrollbar edge, pointer-transparent. */
function MatchMap({ ticks }: { ticks: readonly Tick[] }) {
  if (ticks.length === 0) return null;
  return (
    <div className="find-map" aria-hidden data-testid="thread-find-map">
      {ticks.map((t, i) => (
        <span key={i} className={cn(t.current && "current")} data-current={t.current || undefined} style={{ top: `${String(t.at * 100)}%` }} />
      ))}
    </div>
  );
}

