import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { findDoc, matchIndex, matchRows, rowOrder, startIndex, type FindKey, type FindMatch } from "@/lib/threadFind";
import { cn } from "@/lib/utils";
import { getTimeline } from "@/stores/cite";
import { useThreadStore } from "@/stores/thread";
import { setThreadFindCurrent, useThreadFindAim, useThreadFindCurrent, useThreadFindMatches, useThreadFindOpen, useThreadFindQuery
, useThreadFindRevealSeq } from "@/stores/threadFind";
import { clearMatches, openFor, paintMatches, putBack, revealMatch, timelineIn, type Opened } from "./findDom";
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
  const matches = useThreadFindMatches(threadId, query);
  const current = useThreadFindCurrent(threadId);
  const aim = useThreadFindAim(threadId);
  const revealSeq = useThreadFindRevealSeq(threadId);
  const [ticks, setTicks] = useState<readonly Tick[]>([]);
  const latest = useRef({ query, matches, current });
  useLayoutEffect(() => {
    latest.current = { query, matches, current };
  });

  // Pick the current match: when the query changed (or a hand-off named an item), and when
  // the current one went away (its item changed under it).
  useEffect(() => {
    const stale = current !== null && matchIndex(matches, current) < 0;
    if (!aim && !stale) return;
    if (matches.length === 0) {
      if (aim || current) setThreadFindCurrent(threadId, null);
      return;
    }
    const log = useThreadStore.getState().logs[threadId];
    const order = new Map((log?.order ?? []).map((id, i) => [id, i]));
    const from = aim?.kind === "view" && aim.fromItem !== undefined ? order.get(aim.fromItem) : undefined;
    const i = startIndex(matches, order, { ...(aim?.kind === "item" && { itemId: aim.itemId }), fromOrder: from ?? topOrder(threadId, order) });
    const m = matches[i];
    setThreadFindCurrent(threadId, m ? { itemId: m.itemId, nth: m.nth } : null);
  }, [threadId, aim, matches, current]);

  // Paint what renders; again when rows mount or text changes (one frame later), and, for
  // the overlay fallback, as the list scrolls. The ticks follow the same refresh.
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    const pane = paneRef.current;
    const scroller = pane ? timelineIn(pane) : null;
    if (!pane || !scroller) return;
    let raf = 0;
    const run = () => {
      raf = 0;
      const l = latest.current;
      paintMatches(scroller, l.query, l.current);
      setTicks((prev) => {
        const next = ticksOf(threadId, l.matches, l.current, scroller);
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
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
      scroller.removeEventListener("scroll", schedule);
      refresh.current = () => undefined;
      clearMatches();
    };
  }, [threadId, paneRef]);
  useEffect(() => {
    refresh.current();
  }, [query, matches, current]);

  // A new current match (or a step onto the same one): open what hides it, scroll it in.
  // What the last one opened is put back in the same tick (findDom openFor), and when the
  // bar closes.
  const opened = useRef<{ itemId: string; opened: Opened } | null>(null);
  useEffect(() => {
    const pane = paneRef.current;
    if (!current || !pane) {
      // A query being typed keeps what is open until its first match is picked (the same
      // question again, often): putting it back first would fold and unfold it on screen.
      if (aim) return;
      putBack(threadId, opened.current?.opened ?? null);
      opened.current = null;
      return;
    }
    const it = useThreadStore.getState().logs[threadId]?.byId[current.itemId];
    const kind = it ? findDoc(it)?.kind : undefined;
    if (opened.current?.itemId !== current.itemId) opened.current = { itemId: current.itemId, opened: openFor(threadId, current.itemId, kind, opened.current?.opened ?? null) };
    let live = true;
    void revealMatch(threadId, pane, current, latest.current.query, () => live).then(() => {
      if (live) refresh.current();
    });
    return () => {
      live = false;
    };
  }, [threadId, paneRef, current, revealSeq, aim]);
  useEffect(
    () => () => {
      putBack(threadId, opened.current?.opened ?? null);
      opened.current = null;
    },
    [threadId],
  );

  return <MatchMap ticks={ticks} />;
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

/** The match map's ticks: each match at its row's place in the list (measured, else estimated), one tick per spot. */
function ticksOf(threadId: string, matches: readonly FindMatch[], current: FindKey | null, scroller: HTMLElement): Tick[] {
  const tl = getTimeline(threadId);
  const total = scroller.scrollHeight;
  if (!tl || total <= 0 || matches.length === 0) return [];
  const order = useThreadStore.getState().logs[threadId]?.order ?? [];
  const rows = matchRows(order, tl.rowKeys(), matches);
  const spots = new Map<number, Tick>();
  matches.forEach((m, i) => {
    const at = Math.min(1, (tl.rowStart(rows[i] ?? 0) ?? 0) / total);
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

