import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { buildRows, buildTurns, decodeTimelineKey, type TimelineRow } from "@/lib/threadTimeline";
import { deferTurnFolds, foldDeferredTurns, forgetTurnView, useDeferredTurns, useTimelineKeys, useTurnFolds, watchTurnEnds } from "@/stores/thread";
import { KeepRowContext } from "./context";
import { TimelineRowView } from "./rows";

/** Within this many px of the bottom the list follows new content. */
const PIN_SLACK = 48;
/** A scroll this soon (ms) after the user's wheel, touch or key input is theirs. */
const USER_SCROLL_MS = 400;
/** Keys that scroll the list. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

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
    case "system":
      return 46;
    default:
      return 26;
  }
}

/** The timeline's rows from the items' structure (lib/threadTimeline); text deltas do not rebuild it. */
function useRows(threadId: string, working: boolean): TimelineRow[] {
  const keys = useTimelineKeys(threadId);
  const folds = useTurnFolds(threadId);
  const deferred = useDeferredTurns(threadId);
  const turns = useMemo(() => buildTurns(keys.map(decodeTimelineKey)), [keys]);
  return useMemo(() => buildRows(turns, { fold: (k) => folds[k], deferred: (e) => deferred[e] === true, working }), [turns, folds, deferred, working]);
}

/**
 * The conversation, virtualized (@tanstack/react-virtual, already used by the PR surface):
 * only rows near the viewport mount, each measured once rendered, so a thread of thousands
 * of rows stays cheap. It sticks to the bottom like a live chat while the user is there
 * (new rows, growing text), and stays put once they scroll up. Only the user unpins it: a
 * scroll away from the bottom right after their wheel, touch, scroll key or a drag of the
 * scrollbar. Scrolls nobody asked for (the virtualizer keeping rows in place while it
 * measures the ones above, the browser clamping a shrinking list) never do, or the list
 * would stop short of the last rows (a finished turn's answer under the composer). A turn's
 * header keeps its place on screen when the user folds or unfolds the turn with it.
 * A turn that ends folds only while the list is pinned; scrolled up, it stays open under
 * the reader (its header turns from "Working" into "Worked for" in place) and folds once
 * the list is pinned again (docs/notes/thread-fold-4-pinned-fold.md). Leaving the thread
 * (this list unmounts) forgets its fold and expand choices: every finished turn is folded
 * on the next visit.
 * `bottomInset` is the floating composer's height: the last row scrolls clear of it.
 * Away from the bottom, a "Jump to bottom" chip floats above the composer; it scrolls
 * down and pins the list again.
 */
export function Timeline({ threadId, working, bottomInset }: { threadId: string; working: boolean; bottomInset: number }) {
  const rows = useRows(threadId, working);
  return <TimelineList threadId={threadId} rows={rows} bottomInset={bottomInset} renderRow={renderTimelineRow} turns />;
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
 * turns, which fold when they end (pinned) and forget their fold choices when the list
 * unmounts; the subagent view's rows (SubagentPane) are no turns.
 */
export function TimelineList<R extends ListRow>({
  threadId,
  rows,
  bottomInset,
  renderRow,
  estimateRow = estimate,
  turns = false,
}: {
  threadId: string;
  rows: readonly R[];
  bottomInset: number;
  renderRow: (row: R) => ReactNode;
  estimateRow?: (row: R | undefined) => number;
  turns?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** When the user last gave scroll input (wheel, touch, key); Infinity while a pointer is down on the list (its scrollbar). */
  const userInput = useRef(-Infinity);
  const markInput = useCallback(() => {
    if (userInput.current !== Infinity) userInput.current = performance.now();
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
  // Leaving the thread: the next visit shows every finished turn folded.
  useEffect(() => {
    if (!turns) return;
    return () => {
      forgetTurnView(threadId);
    };
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

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Follow the bottom while pinned: whenever the content's height changes (rows measured,
  // text streaming in, the composer growing), or the list's own (the bottom panel opening
  // under the pane, e.g. a code block's Run in terminal).
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    if (pinned.current) toBottom();
    const ro = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    ro.observe(inner);
    if (scrollRef.current) ro.observe(scrollRef.current);
    return () => {
      ro.disconnect();
    };
  }, [toBottom]);
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
    captureAnchor();
  }, [rows, bottomInset, toBottom, v, captureAnchor, pin]);

  return (
    <KeepRowContext.Provider value={keepRow}>
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
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
          if (bottom) pin();
          else if (performance.now() - userInput.current < USER_SCROLL_MS) pinned.current = false;
          else if (pinned.current) toBottom();
          if (bottom !== atBottom) setAtBottom(bottom);
          captureAnchor();
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
                style={{ position: "absolute", top: 0, left: 40, right: 40, transform: `translateY(${String(vi.start)}px)` }}
              >
                {renderRow(row)}
              </div>
            );
          })}
        </div>
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
          toBottom();
        }}
      >
        <ArrowDown aria-hidden />
        Jump to bottom
      </button>
    </KeepRowContext.Provider>
  );
}
