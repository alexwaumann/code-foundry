import { memo, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Tip } from "@/components/ui/tooltip";
import { sentTime } from "@/lib/format";
import { promptInView, promptPreview, railGap, TICK_PX, tickLabel } from "@/lib/promptRail";
import type { TimelineRow } from "@/lib/threadTimeline";
import { parseUserMessage } from "@/lib/userMessage";
import { cn } from "@/lib/utils";
import { useThreadItem, useThreadStore } from "@/stores/thread";
import type { TimelineListApi } from "./Timeline";

/** Space (px) kept clear above the rail and between it and the composer. */
const RAIL_MARGIN = 16;

/** A prompt on the rail: its user row's item id and the row's index in the timeline. */
interface RailPrompt {
  id: string;
  index: number;
}

/**
 * The thread's prompt rail (docs/notes/thread-prompt-rail.md): one tick per prompt the
 * timeline shows as a bubble (its `user` rows, wakes left out), in the rows' 40px left
 * gutter, centred in the body above the composer. The tick of the turn in view (the last
 * prompt whose row top is at or above the viewport's middle) is full strength; hovering one
 * shows the prompt, a click scrolls its row to the top (focus stays where it was). Ticks
 * pack closer in a long thread (lib/promptRail railGap); when they cannot fit, or the thread
 * has fewer than two prompts, there is no rail. Only the rail re-renders as the list
 * scrolls: it reads the list's scroll in a frame callback and sets the tick in view when it
 * changes.
 */
export const PromptRail = memo(function PromptRail({ threadId, list, rows, bottomInset }: { threadId: string; list: TimelineListApi; rows: readonly TimelineRow[]; bottomInset: number }) {
  const userRows = useMemo(() => rows.flatMap((r, index) => (r.type === "user" ? [{ id: r.id, index }] : [])), [rows]);
  // A wake (the daemon's message for a subscription, WakeNotes) is no bubble and no prompt the user wrote.
  const bubbles = useThreadStore(
    useShallow((s) => {
      const log = s.logs[threadId];
      return userRows.flatMap((u) => {
        const it = log?.byId[u.id];
        return it?.kind === "user" && !it.wake ? [u.id] : [];
      });
    }),
  );
  const prompts = useMemo<RailPrompt[]>(() => {
    const keep = new Set(bubbles);
    return userRows.filter((u) => keep.has(u.id));
  }, [userRows, bubbles]);

  // The height the ticks may take: the body above the composer, less the margins. Measured
  // once per resize of the list.
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const el = list.scroller();
    if (!el) return;
    const measure = () => {
      setAvailable(el.clientHeight - bottomInset - 2 * RAIL_MARGIN);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [list, bottomInset]);

  // The prompt in view, read at most once a frame: on scroll, and when the list or its rows resize.
  const [current, setCurrent] = useState(-1);
  const shown = prompts.length > 0;
  useEffect(() => {
    const el = list.scroller();
    if (!el || !shown) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const middle = el.scrollTop + Math.max(el.clientHeight - bottomInset, 0) / 2;
      setCurrent(
        promptInView(
          prompts.map((p) => list.rowStart(p.index)),
          middle,
        ),
      );
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(update);
    };
    schedule();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [list, prompts, shown, bottomInset]);

  const gap = railGap(prompts.length, available);
  if (gap === null) return null;
  return (
    <nav
      aria-label="Prompts"
      data-testid="prompt-rail"
      data-gap={gap}
      className="pointer-events-none absolute left-2 z-1 flex flex-col justify-center"
      style={{ top: RAIL_MARGIN, bottom: bottomInset + RAIL_MARGIN }}
    >
      <ol className="pointer-events-auto flex flex-col">
        {prompts.map((p, i) => (
          <PromptTick key={p.id} threadId={threadId} id={p.id} index={p.index} n={i + 1} total={prompts.length} gap={gap} current={i === current} list={list} />
        ))}
      </ol>
    </nav>
  );
});

/** One prompt's tick: an 8×2 bar in a button as tall as the bar and one gap; its tooltip shows the prompt. */
const PromptTick = memo(function PromptTick({
  threadId,
  id,
  index,
  n,
  total,
  gap,
  current,
  list,
}: {
  threadId: string;
  id: string;
  index: number;
  n: number;
  total: number;
  gap: number;
  current: boolean;
  list: TimelineListApi;
}) {
  const it = useThreadItem(threadId, id);
  const user = it?.kind === "user" ? it : undefined;
  const preview = useMemo(() => (user ? promptPreview(parseUserMessage(user.text, user.composerText, user.attachments)) : ""), [user]);
  const meta = [sentTime(it?.createdAtMs ?? null), `${String(n)} of ${String(total)}`].filter(Boolean).join(" · ");
  const tip = (
    <span className="flex flex-col gap-0.5 whitespace-normal">
      <span className={cn("line-clamp-2", !preview && "text-cf-text-muted")}>{preview || "Attachments only"}</span>
      <span className="text-caption text-cf-text-muted tabular-nums">{meta}</span>
    </span>
  );
  return (
    <li className="flex">
      <Tip label={tip} side="right" className="max-w-65" data-testid="prompt-rail-tip">
        <button
          type="button"
          aria-label={tickLabel(n, total, preview)}
          aria-current={current ? "location" : undefined}
          data-testid="prompt-rail-tick"
          data-current={current || undefined}
          className="group flex w-6 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-cf-focus/50"
          style={{ height: TICK_PX + gap }}
          onMouseDown={(e) => {
            // A click jumps; the focus stays where it was (the composer).
            e.preventDefault();
          }}
          onClick={() => {
            list.scrollToRow(index);
          }}
        >
          <span
            aria-hidden
            className={cn(
              "h-0.5 w-2 rounded-full transition-colors duration-100",
              current ? "bg-cf-text" : "bg-cf-text-muted/45 group-hover:bg-cf-text group-focus-visible:bg-cf-text",
            )}
          />
        </button>
      </Tip>
    </li>
  );
});
