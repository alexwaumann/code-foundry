import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, SearchIcon, Sparkle, X } from "lucide-react";
import type { SearchEntryView } from "@/api/search";
import { Tip } from "@/components/ui/tooltip";
import { recentMeta, resultsWord, type UnseenCue } from "@/lib/agentSearch";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { AnswerText, HitRow, SectionHeading, SummaryLine } from "./AgentParts";

/** A Recent searches row's height (fixed: the list is virtualized). */
export const RECENT_ROW_HEIGHT = 32;

/** What the dialog's Recent searches need: the history, the selected row and what a row does. */
export interface RecentApi {
  /** The history, newest first; null until it arrives. */
  list: readonly SearchEntryView[] | null;
  selectedId: string | null;
  select: (id: string) => void;
  /** Enter or a click: an agent entry's saved results; a Find entry runs again. */
  pick: (e: SearchEntryView) => void;
  forget: (id: string) => void;
  clear: () => void;
}

/** A Recent searches row's count and age, ticking each second (only this span re-renders). */
function RecentMeta({ entry }: { entry: SearchEntryView }) {
  const now = useNow(1000);
  return (
    <span className="shrink-0 text-caption text-cf-text-muted tabular-nums" data-testid="search-recent-meta">
      {recentMeta(entry, now)}
    </span>
  );
}

/** The empty state's history (both modes): agent entries with a sparkle and their result count, Find entries with a search icon and their hit count; × forgets, Clear empties it. */
export function RecentList({ recent }: { recent: RecentApi }) {
  const list = recent.list ?? [];
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({
    count: list.length,
    getScrollElement: () => ref.current,
    estimateSize: () => RECENT_ROW_HEIGHT,
    getItemKey: (i) => list[i]?.id ?? i,
    overscan: 8,
    paddingEnd: 8,
  });
  const selectedIndex = list.findIndex((e) => e.id === recent.selectedId);
  useEffect(() => {
    if (selectedIndex >= 0) v.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, v]);
  if (list.length === 0) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="search-recent">
      <SectionHeading
        right={
          <button
            type="button"
            className="text-caption text-cf-text-muted outline-none hover:text-cf-text focus-visible:underline"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={recent.clear}
            data-testid="search-recent-clear"
          >
            Clear
          </button>
        }
      >
        Recent searches
      </SectionHeading>
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-2" role="listbox" aria-label="Recent searches" data-testid="search-recent-list">
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((vi) => {
            const e = list[vi.index];
            if (!e) return null;
            const selected = e.id === recent.selectedId;
            const Icon = e.mode === "agent" ? Sparkle : SearchIcon;
            return (
              <div
                key={e.id}
                role="option"
                aria-selected={selected}
                className={cn("group/recent flex cursor-default items-center gap-2 rounded-md px-2", selected && "bg-cf-control-hover")}
                style={{ position: "absolute", top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${String(vi.start)}px)` }}
                data-testid="search-recent-row"
                data-id={e.id}
                data-mode={e.mode}
                data-selected={selected || undefined}
                onPointerMove={
                  selected
                    ? undefined
                    : () => {
                        recent.select(e.id);
                      }
                }
                onMouseDown={(ev) => {
                  ev.preventDefault();
                }}
                onClick={() => {
                  recent.pick(e);
                }}
              >
                {e.mode === "agent" && e.status === "running" ? <Loader2 className="size-3.5 shrink-0 animate-spin text-cf-icon-muted" aria-hidden /> : <Icon className="size-3.5 shrink-0 text-cf-icon-muted" aria-hidden />}
                <span className="min-w-0 flex-1 truncate text-body-sm text-cf-text">{e.query}</span>
                <RecentMeta entry={e} />
                <Tip label="Forget">
                  <button
                    type="button"
                    aria-label="Forget"
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-sm text-cf-text-muted outline-none hover:bg-cf-control-active hover:text-cf-text",
                      selected ? "visible" : "invisible group-hover/recent:visible",
                    )}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      recent.forget(e.id);
                    }}
                    data-testid="search-recent-forget"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </Tip>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The right side for a Recent row: an agent entry's saved results (not run again), or what Enter does for a Find entry. */
export function RecentPreview({ entry }: { entry: SearchEntryView }) {
  if (entry.mode === "find") {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center px-8 text-center text-body-sm text-cf-text-muted" data-testid="search-recent-preview" data-mode="find">
        ⏎ runs Find for “{entry.query}” again.
      </div>
    );
  }
  return (
    <div className="min-w-0 flex-1 overflow-y-auto px-4 pt-4 pb-4" data-testid="search-recent-preview" data-mode="agent">
      <p className="px-3 text-caption text-cf-text-muted">{entry.status === "running" ? "Still running · ⏎ shows it" : "Saved results · not re-run"}</p>
      {entry.answer && <AnswerText answer={entry.answer} hits={entry.hits} className="px-3 pt-3 pb-1" />}
      {entry.status !== "running" && entry.steps.length > 0 && <SummaryLine entry={entry} />}
      <div className="mt-2 flex flex-col gap-0.5">
        {entry.hits.map((h) => (
          <HitRow key={h.n} hit={h} selected={false} />
        ))}
      </div>
    </div>
  );
}

/**
 * A restored dialog's cue for a finished agent search it has not shown (unseen): "Finished:
 * <query> · 3 results", with "+N more" when there are several (the newest is named). A
 * click shows it, which marks it seen; the restored search stays until then.
 */
export function UnseenCueRow({ cue, onPick }: { cue: UnseenCue; onPick: (e: SearchEntryView) => void }) {
  return (
    <div className="px-2 pt-2">
      <Tip label={cue.entry.query} whenTruncated maxLines={4}>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-left text-body-sm text-cf-text outline-none hover:bg-cf-control-hover focus-visible:ring-2 focus-visible:ring-cf-focus/50"
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            onPick(cue.entry);
          }}
          data-testid="search-unseen-cue"
          data-id={cue.entry.id}
        >
          <Sparkle className="size-3.5 shrink-0 text-cf-icon-muted" aria-hidden />
          <span className="shrink-0 text-cf-text-muted">Finished:</span>
          <span className="min-w-0 truncate">{cue.entry.query}</span>
          <span className="shrink-0 text-cf-text-muted">· {resultsWord(cue.entry)}</span>
          {cue.more > 0 && (
            <span className="ml-auto shrink-0 pl-2 text-caption text-cf-text-muted" data-testid="search-unseen-more">
              +{cue.more} more
            </span>
          )}
        </button>
      </Tip>
    </div>
  );
}
