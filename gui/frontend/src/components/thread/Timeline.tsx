import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { buildRows, buildTurns, decodeTimelineKey, type TimelineRow } from "@/lib/threadTimeline";
import { useTimelineKeys, useTurnFolds } from "@/stores/thread";
import { TimelineRowView } from "./rows";

/** Within this many px of the bottom the list follows new content. */
const PIN_SLACK = 48;
/** A scroll this soon (ms) after the user's wheel, touch or key input is theirs. */
const USER_SCROLL_MS = 400;
/** Keys that scroll the list. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** A first guess of a row's height before it is measured. */
function estimate(r: TimelineRow | undefined): number {
  switch (r?.type) {
    case "user":
      return 72;
    case "text":
      return 64;
    case "footer":
      return 58;
    case "working":
      return 58;
    default:
      return 26;
  }
}

/** The timeline's rows from the items' structure (lib/threadTimeline); text deltas do not rebuild it. */
function useRows(sessionId: string, working: boolean): TimelineRow[] {
  const keys = useTimelineKeys(sessionId);
  const folds = useTurnFolds(sessionId);
  const turns = useMemo(() => buildTurns(keys.map(decodeTimelineKey)), [keys]);
  return useMemo(() => buildRows(turns, { fold: (k) => folds[k], working }), [turns, folds, working]);
}

/**
 * The conversation, virtualized (@tanstack/react-virtual, already used by the PR surface):
 * only rows near the viewport mount, each measured once rendered, so a thread of thousands
 * of rows stays cheap. It sticks to the bottom like a live chat while the user is there
 * (new rows, growing text), and stays put once they scroll up. Only the user unpins it: a
 * scroll away from the bottom right after their wheel, touch, scroll key or a drag of the
 * scrollbar. Scrolls nobody asked for (the virtualizer keeping rows in place while it
 * measures the ones above, the browser clamping a shrinking list) never do, or the list
 * would stop short of the last rows (a finished turn's footer under the composer).
 * `bottomInset` is the floating composer's height: the last row scrolls clear of it.
 * Away from the bottom, a "Jump to bottom" chip floats above the composer; it scrolls
 * down and pins the list again.
 */
export function Timeline({ sessionId, working, bottomInset }: { sessionId: string; working: boolean; bottomInset: number }) {
  const rows = useRows(sessionId, working);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** When the user last gave scroll input (wheel, touch, key); Infinity while a pointer is down on the list (its scrollbar). */
  const userInput = useRef(-Infinity);
  const markInput = useCallback(() => {
    if (userInput.current !== Infinity) userInput.current = performance.now();
  }, []);
  const [atBottom, setAtBottom] = useState(true);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimate(rows[i]),
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
  // text streaming in, the composer growing).
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    if (pinned.current) toBottom();
    const ro = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
    };
  }, [toBottom]);
  useLayoutEffect(() => {
    if (pinned.current) toBottom();
  }, [rows, bottomInset, toBottom]);

  return (
    <>
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
          if (bottom) pinned.current = true;
          else if (performance.now() - userInput.current < USER_SCROLL_MS) pinned.current = false;
          else if (pinned.current) toBottom();
          if (bottom !== atBottom) setAtBottom(bottom);
        }}
      >
        <div ref={innerRef} className="col" role="log" aria-label="Conversation" style={{ position: "relative", height: v.getTotalSize() }}>
          {v.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                data-row-type={row.type}
                ref={v.measureElement}
                style={{ position: "absolute", top: 0, left: 40, right: 40, transform: `translateY(${String(vi.start)}px)` }}
              >
                <TimelineRowView row={row} />
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
          pinned.current = true;
          toBottom();
        }}
      >
        <ArrowDown aria-hidden />
        Jump to bottom
      </button>
    </>
  );
}
