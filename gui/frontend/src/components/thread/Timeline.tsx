import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { buildRows, buildTurns, decodeTimelineKey, type TimelineRow } from "@/lib/threadTimeline";
import { deferTurnFolds, foldDeferredTurns, useDeferredTurns, useTimelineKeys, useTurnFolds, watchTurnEnds } from "@/stores/thread";
import { registerTimeline } from "@/stores/cite";
import { heldScroll, spacerAfterGrowth } from "@/lib/timelineHold";
import { scrollIntent, type ScrollSample } from "@/lib/scrollIntent";
import { HoldTopContext, KeepRowContext } from "./context";
import { RowBoundary } from "./RowError";
import { TimelineRowView } from "./rows";

/** Within this many px of the bottom the list follows new content. */
const PIN_SLACK = 48;
/** A scroll this soon (ms) after the user's wheel, touch or key input is theirs. */
const USER_SCROLL_MS = 400;
/** How long (ms) after a card asks for it its top is held (HoldTopContext): the resize's layout passes. */
const HOLD_MS = 400;
/** Keys that scroll the list. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
/** A page's frame under the pointer (an inline page card's): its wheel never reaches the list (lib/scrollIntent.ts). */
const HOVERED_FRAME = "iframe:hover";

/** A first guess of a row's height before it is measured. */
function estimate(r: { type: string } | undefined): number {
  switch (r?.type) {
    case "user":
      return 72;
    case "steer":
      return 64;
    case "text":
      return 64;
    case "header":
      return 28;
    case "strip":
      return 26;
    case "system":
      return 46;
    case "html":
      return 470;
    case "theme":
      return 132;
    default:
      return 26;
  }
}

/** The timeline's rows from the items' structure (lib/threadTimeline); text deltas do not rebuild it. */
function useRows(threadId: string, working: boolean, strips: boolean): TimelineRow[] {
  const keys = useTimelineKeys(threadId);
  const folds = useTurnFolds(threadId);
  const deferred = useDeferredTurns(threadId);
  const turns = useMemo(() => buildTurns(keys.map(decodeTimelineKey)), [keys]);
  return useMemo(() => buildRows(turns, { fold: (k) => folds[k], deferred: (e) => deferred[e] === true, working, strips }), [turns, folds, deferred, working, strips]);
}

/**
 * The conversation, virtualized (@tanstack/react-virtual, already used by the PR surface):
 * only rows near the viewport mount, each measured once rendered, so a thread of thousands
 * of rows stays cheap. It sticks to the bottom like a live chat while the user is there
 * (new rows, growing text), and stays put once they scroll up. Only the user unpins it: a
 * scroll away from the bottom right after their wheel, touch, scroll key or a drag of the
 * scrollbar, or an upward one with the pointer over a page's frame, whose wheel goes to the
 * page (lib/scrollIntent.ts, docs/notes/inline-page-frame.md). Scrolls nobody asked for (the virtualizer keeping rows in place while it
 * measures the ones above, the browser clamping a shrinking list) never do, or the list
 * would stop short of the last rows (a finished turn's answer under the composer). A turn's
 * header keeps its place on screen when the user folds or unfolds the turn with it.
 * A turn that ends folds only while the list is pinned; scrolled up, it stays open under
 * the reader (its header turns from "Working" into "Worked for" in place) and folds once
 * the list is pinned again (docs/notes/thread-fold-4-pinned-fold.md). Leaving the thread
 * forgets its fold and expand choices (ThreadPane's WatchedThread): every finished turn is
 * folded on the next visit. A visit to one of its subagent runs is not leaving it.
 * While the thread is on a turn (`strips`: working, or waiting on the user), that turn's
 * runs of work show as strip rows (docs/notes/live-tool-strip.md).
 * `bottomInset` is the floating composer's height: the last row scrolls clear of it.
 * Away from the bottom, a "Jump to bottom" chip floats above the composer; it scrolls
 * down and pins the list again.
 */
export function Timeline({ threadId, working, strips, bottomInset, inset }: { threadId: string; working: boolean; strips: boolean; bottomInset: number; inset?: number }) {
  const rows = useRows(threadId, working, strips);
  return <TimelineList threadId={threadId} rows={rows} bottomInset={bottomInset} renderRow={renderTimelineRow} turns inset={inset} />;
}

function renderTimelineRow(row: TimelineRow) {
  return <TimelineRowView row={row} />;
}

/** A row of a TimelineList: its stable key and its type (the estimate's and the turn spacing's). */
export interface ListRow {
  key: string;
  type: string;
}

/**
 * The timeline's list (Timeline above): rows virtualized, following the bottom while
 * pinned, keeping the reader's place when rows change. `turns`: the rows are the thread's
 * turns, which fold when they end (pinned); the subagent view's rows (SubagentPane) are no
 * turns.
 */
export function TimelineList<R extends ListRow>({
  threadId,
  rows,
  bottomInset,
  renderRow,
  estimateRow = estimate,
  turns = false,
  citable = turns,
  unfold,
  inset = 40,
}: {
  threadId: string;
  rows: readonly R[];
  bottomInset: number;
  renderRow: (row: R) => ReactNode;
  estimateRow?: (row: R | undefined) => number;
  turns?: boolean;
  /** The cite layer can bring its rows into view (stores/cite registerTimeline): the thread's own timeline (turns) and Ember's chat. */
  citable?: boolean;
  /** Opens what folds the item away (Ember's work row), for the cite layer; without it, the turn the item is in unfolds. */
  unfold?: (rows: readonly R[], itemId: string) => boolean;
  /** The rows' left and right inset in px (40 in the content pane, less in a narrow side panel). */
  inset?: number | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** When the user last gave scroll input (wheel, touch, key); Infinity while a pointer is down on the list (its scrollbar). */
  const userInput = useRef(-Infinity);
  const markInput = useCallback(() => {
    if (userInput.current !== Infinity) userInput.current = performance.now();
  }, []);
  /** Where the scroller was when last seen (a scroll, a resize, a change of rows): what scrollIntent compares a scroll with. */
  const seen = useRef<ScrollSample>({ top: 0, height: 0 });
  const noteScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) seen.current = { top: el.scrollTop, height: el.scrollHeight };
  }, []);
  const [atBottom, setAtBottom] = useState(true);
  /** Pins the list (it follows the bottom again); the turns left open while it was scrolled up fold. */
  const pin = useCallback(() => {
    pinned.current = true;
    if (turns) foldDeferredTurns(threadId);
  }, [threadId, turns]);

  // A turn's end arrives: scrolled up, the turn stays open (decided inside the store update
  // that brings the turn_end, so the rows never render folded first).
  useLayoutEffect(() => {
    if (!turns) return;
    return watchTurnEnds(threadId, (ids) => {
      if (!pinned.current) deferTurnFolds(threadId, ids);
    });
  }, [threadId, turns]);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimateRow(rows[i]),
    overscan: 8,
    paddingStart: 28,
    paddingEnd: bottomInset + 8,
    useFlushSync: false,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  // A row whose top is held on screen while it resizes (holdTop), and the spacer under the
  // rows that lets a held card at the bottom shrink without moving (lib/timelineHold.ts).
  const held = useRef<{ el: HTMLElement; top: number; until: number } | null>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  // The spacer's height and the rows' height when it was last set.
  const spacer = useRef({ px: 0, rows: 0 });
  const setSpacer = useCallback((px: number) => {
    spacer.current = { px, rows: innerRef.current?.offsetHeight ?? 0 };
    if (spacerRef.current) spacerRef.current.style.height = `${String(px)}px`;
  }, []);
  const holdTop = useCallback((el: HTMLElement) => {
    held.current = { el, top: el.getBoundingClientRect().top, until: performance.now() + HOLD_MS };
  }, []);
  /** Puts a held row's top back where it was; false when no row is held. */
  const restoreHeld = useCallback((): boolean => {
    const h = held.current;
    const el = scrollRef.current;
    if (!h || !el) return false;
    if (performance.now() > h.until || !h.el.isConnected) {
      held.current = null;
      return false;
    }
    const moved = h.el.getBoundingClientRect().top - h.top;
    if (Math.abs(moved) < 0.5) return true;
    const next = heldScroll({ scrollTop: el.scrollTop, contentHeight: innerRef.current?.offsetHeight ?? 0, clientHeight: el.clientHeight }, moved);
    setSpacer(next.spacer);
    el.scrollTop = next.scrollTop;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
    pinned.current = bottom;
    setAtBottom(bottom);
    return true;
  }, [setSpacer]);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restoreHeld()) return;
    // Rows growing under a held card's spacer take its place, so their end stays put.
    const s = spacer.current;
    if (s.px > 0) setSpacer(spacerAfterGrowth(s.px, s.rows, innerRef.current?.offsetHeight ?? 0));
    el.scrollTop = el.scrollHeight;
  }, [restoreHeld, setSpacer]);

  // The cite layer brings a quoted item's row into view (stores/cite.ts): the thread's
  // own timeline (its rows are the turns) or Ember's chat, not a subagent's.
  const rowsRef = useRef(rows);
  const unfoldRef = useRef(unfold);
  useLayoutEffect(() => {
    rowsRef.current = rows;
    unfoldRef.current = unfold;
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!citable || !el) return;
    return registerTimeline(threadId, {
      scroller: el,
      showRow: (key) => {
        const i = rowsRef.current.findIndex((r) => r.key === key);
        if (i < 0) return false;
        const node = el.querySelector(`[data-index="${String(i)}"]`);
        const box = el.getBoundingClientRect();
        const at = node?.getBoundingClientRect();
        if (at && at.top >= box.top && at.bottom <= box.bottom) return true;
        pinned.current = false;
        v.scrollToIndex(i, { align: "center" });
        return true;
      },
      unpin: () => {
        pinned.current = false;
      },
      unfold: unfoldRef.current ? (itemId) => unfoldRef.current?.(rowsRef.current, itemId) ?? false : undefined,
    });
  }, [threadId, citable, v]);

  // Follow the bottom while pinned: whenever the content's height changes (rows measured,
  // text streaming in, the composer growing), or the list's own (the bottom panel opening
  // under the pane, e.g. a code block's Run in terminal).
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    if (pinned.current) toBottom();
    noteScroll();
    const ro = new ResizeObserver(() => {
      if (!restoreHeld() && pinned.current) toBottom();
      noteScroll();
    });
    ro.observe(inner);
    if (scrollRef.current) ro.observe(scrollRef.current);
    return () => {
      ro.disconnect();
    };
  }, [toBottom, restoreHeld, noteScroll]);
  // Away from the bottom, the row at the top of the viewport (and how far it starts above
  // the viewport's top) is the anchor a change of rows keeps in place.
  const anchor = useRef<{ index: number; offset: number; rows: readonly R[] } | null>(null);
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    const vi = el ? v.getVirtualItemForOffset(el.scrollTop) : undefined;
    anchor.current = el && vi ? { index: vi.index, offset: vi.start - el.scrollTop, rows } : null;
  }, [v, rows]);

  // A header the user clicks (to fold or unfold its turn) and where it was on screen: the
  // next change of rows puts it back there, pinned or not (KeepRowContext).
  const kept = useRef<{ key: string; offset: number } | null>(null);
  const keepRow = useCallback(
    (key: string) => {
      const el = scrollRef.current;
      const m = v.measurementsCache.find((x) => x.key === key);
      kept.current = el && m ? { key, offset: m.start - el.scrollTop } : null;
    },
    [v],
  );

  // Rows change (a turn folds when it ends pinned or when the list pins again, the user
  // folds one, rows arrive). A header the user just clicked stays where it was on screen:
  // its turn's work opens or closes below it, so the rows above it, and its start, do not
  // move; the list unpins unless the fold left too little below to keep the place (then it
  // sits at the bottom). Otherwise, pinned, the list follows the bottom. Scrolled up (a turn
  // that ends then stays open), the anchor row keeps its place; when it went away (an
  // explore row merging into a group) the nearest row before it that is still there takes
  // that place, so the viewport never jumps to an unrelated part of the conversation. When
  // that place is past the new bottom, the list pins again.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    const k = kept.current;
    kept.current = null;
    const held = k && el ? v.measurementsCache.find((x) => x.key === k.key) : undefined;
    if (k && el && held) {
      const top = held.start - k.offset;
      const max = el.scrollHeight - el.clientHeight;
      if (top >= max) pin();
      else pinned.current = false;
      el.scrollTop = Math.min(top, max);
      setAtBottom(max - el.scrollTop < PIN_SLACK);
    } else if (!pinned.current && el && a && a.rows !== rows) {
      const index = new Map(rows.map((r, i) => [r.key, i]));
      let at = index.get(a.rows[a.index]?.key ?? "");
      for (let i = a.index - 1; at === undefined && i >= 0; i--) at = index.get(a.rows[i]?.key ?? "");
      for (let i = a.index + 1; at === undefined && i < a.rows.length; i++) at = index.get(a.rows[i]?.key ?? "");
      const start = at === undefined ? undefined : v.measurementsCache[at]?.start;
      if (start !== undefined) {
        // The anchor row itself keeps its offset; a row that takes its place starts at the
        // viewport's top, not as far above it as the user had scrolled into the row that
        // folded away (an open tool row's output can be hundreds of px).
        const own = rows[at ?? -1]?.key === a.rows[a.index]?.key;
        const top = start - (own ? a.offset : Math.max(a.offset, 0));
        // Past the new bottom (the fold left too little below to keep the place): pin, so
        // the turn's answer ends up in view rather than wherever the clamp leaves it.
        if (top > el.scrollHeight - el.clientHeight) pin();
        else el.scrollTop = top;
      }
    }
    if (pinned.current) toBottom();
    else restoreHeld();
    captureAnchor();
    noteScroll();
  }, [rows, bottomInset, toBottom, restoreHeld, v, captureAnchor, pin, noteScroll]);

  return (
    <KeepRowContext.Provider value={keepRow}>
      <HoldTopContext.Provider value={holdTop}>
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="thread-timeline"
          data-at-bottom={atBottom || undefined}
          onWheel={markInput}
          onTouchMove={markInput}
          onKeyDown={(e) => {
            if (SCROLL_KEYS.has(e.key)) markInput();
          }}
          onPointerDown={() => {
            userInput.current = Infinity;
            const up = () => {
              userInput.current = performance.now();
              window.removeEventListener("pointerup", up);
              window.removeEventListener("pointercancel", up);
            };
            window.addEventListener("pointerup", up);
            window.addEventListener("pointercancel", up);
          }}
          onScroll={(e) => {
            const el = e.currentTarget;
            // The user's own scroll ends a hold; one nobody asked for (the browser clamping a
            // list a held card shrank) is put back. A scroll with the pointer over a page's
            // frame may be theirs with no input here: the frame's document had the wheel.
            const prev = seen.current;
            noteScroll();
            const theirs =
              scrollIntent({ input: performance.now() - userInput.current < USER_SCROLL_MS, overFrame: el.querySelector(HOVERED_FRAME) !== null, prev, now: seen.current }) === "user";
            if (theirs) held.current = null;
            else if (restoreHeld()) {
              captureAnchor();
              noteScroll();
              return;
            }
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
            if (bottom) pin();
            else if (theirs) pinned.current = false;
            else if (pinned.current) toBottom();
            if (bottom !== atBottom) setAtBottom(bottom);
            captureAnchor();
            noteScroll();
          }}
        >
          <div ref={innerRef} className="col" role="log" aria-label="Conversation" style={{ position: "relative", height: v.getTotalSize() }}>
            {v.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              if (!row) return null;
              // The last row of a turn before the next one gets the space between turns.
              const next = rows[vi.index + 1];
              const turnEnd = row.type !== "user" && row.type !== "system" && (next?.type === "user" || next?.type === "system");
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  data-row-type={row.type}
                  data-turn-end={turnEnd || undefined}
                  ref={v.measureElement}
                  style={{ position: "absolute", top: 0, left: inset, right: inset, transform: `translateY(${String(vi.start)}px)` }}
                >
                  <RowBoundary threadId={threadId} row={row}>
                    {renderRow(row)}
                  </RowBoundary>
                </div>
              );
            })}
          </div>
          <div ref={spacerRef} aria-hidden data-testid="thread-timeline-spacer" style={{ height: 0 }} />
        </div>
        {/* Outside the scroller: it floats over the list's bottom, just above the composer. */}
        <button
          type="button"
          className="jump-bottom"
          data-testid="thread-jump-bottom"
          data-shown={!atBottom || undefined}
          aria-hidden={atBottom || undefined}
          tabIndex={atBottom ? -1 : undefined}
          style={{ bottom: Math.max(bottomInset - 20, 12) }}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            pin();
            setSpacer(0);
            toBottom();
          }}
        >
          <ArrowDown aria-hidden />
          Jump to bottom
        </button>
      </HoldTopContext.Provider>
    </KeepRowContext.Provider>
  );
}
