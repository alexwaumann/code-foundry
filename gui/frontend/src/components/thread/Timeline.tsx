import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { buildRows, buildTurns, decodeTimelineKey, type TimelineRow } from "@/lib/threadTimeline";
import { useTimelineKeys, useTurnFolds } from "@/stores/thread";
import { TimelineRowView } from "./rows";

/** Within this many px of the bottom the list follows new content. */
const PIN_SLACK = 48;

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
 * (new rows, growing text), and stays put once they scroll up. `bottomInset` is the
 * floating composer's height: the last row scrolls clear of it.
 */
export function Timeline({ sessionId, working, bottomInset }: { sessionId: string; working: boolean; bottomInset: number }) {
  const rows = useRows(sessionId, working);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Where the list last scrolled itself to: a scroll event above it is the user's. */
  const autoTop = useRef(0);
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
    autoTop.current = el.scrollTop;
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
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="thread-timeline"
      data-at-bottom={atBottom || undefined}
      onScroll={(e) => {
        const el = e.currentTarget;
        const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
        // Content that grew after the list scrolled itself leaves it short of the bottom
        // without the user moving: only a scroll above that point unpins.
        if (bottom) pinned.current = true;
        else if (el.scrollTop < autoTop.current - 4) pinned.current = false;
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
  );
}
