import { memo, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TextRange } from "@/api/threadSearch";
import { useThreadPlace } from "@/components/thread/useThreadPlace";
import { dayLabel, moreLabel, SEARCH_ROW_HEIGHT, speakerLabel, textRuns, type SearchRow } from "@/lib/threadSearch";
import { cn } from "@/lib/utils";

/** Text with its matches tinted (search.css .search-hit). */
function Marked({ text, ranges }: { text: string; ranges: readonly TextRange[] }) {
  return (
    <>
      {textRuns(text, ranges).map((r, i) =>
        r.hit ? (
          <mark key={i} className="search-hit" data-hit="">
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}

/** "project · archived" after a thread's name. */
function ThreadMeta({ threadId, archived }: { threadId: string; archived: boolean }) {
  const place = useThreadPlace(threadId);
  const project = place.set ?? place.project;
  return (
    <span className="min-w-0 shrink truncate text-body-sm text-cf-text-muted" data-testid="search-row-meta">
      {[project, archived ? "archived" : ""].filter(Boolean).join(" · ")}
    </span>
  );
}

/** One row: a section heading, a thread name, a thread's header under Messages, a hit, "N more" or a note. */
const Row = memo(function Row({ row, selected }: { row: SearchRow; selected: boolean }) {
  const base = "flex h-full items-center gap-2 rounded-md px-3";
  switch (row.kind) {
    case "section":
      return <div className="flex h-full items-end px-3 pb-1.5 text-overline text-cf-text-muted">{row.label}</div>;
    case "name":
      return (
        <div className={cn(base, "cursor-default", selected && "bg-cf-control-hover")} data-testid="search-row" data-kind="name" data-thread={row.name.threadId} data-selected={selected || undefined}>
          <span className="min-w-0 shrink-0 truncate text-body text-cf-text" style={{ maxWidth: "60%" }}>
            <Marked text={row.name.name || row.name.threadId} ranges={row.name.ranges} />
          </span>
          <ThreadMeta threadId={row.name.threadId} archived={row.name.archived} />
          <span className="ml-auto shrink-0 text-caption text-cf-text-muted tabular-nums">{dayLabel(row.name.lastActivityMs)}</span>
        </div>
      );
    case "group":
      return (
        <div className={cn(base, "cursor-default pt-1.5")} data-testid="search-row" data-kind="group" data-thread={row.group.threadId}>
          <span className="min-w-0 shrink-0 truncate text-body font-medium text-cf-text" style={{ maxWidth: "60%" }}>
            {row.group.threadName || row.group.threadId}
          </span>
          <ThreadMeta threadId={row.group.threadId} archived={row.group.archived} />
          <span className="ml-auto shrink-0 text-caption text-cf-text-muted tabular-nums" data-testid="search-row-count">
            {row.group.totalHits}
          </span>
        </div>
      );
    case "hit":
      return (
        <div className={cn(base, "cursor-default", selected && "bg-cf-control-hover")} data-testid="search-row" data-kind="hit" data-thread={row.hit.threadId} data-item={row.hit.itemId} data-selected={selected || undefined}>
          <span className="w-12 shrink-0 text-body-sm text-cf-text-muted" data-testid="search-row-speaker">
            {speakerLabel(row.hit.speaker)}
          </span>
          <span className="min-w-0 flex-1 truncate text-body-sm text-cf-text-secondary">
            <Marked text={row.hit.snippet} ranges={row.hit.ranges} />
          </span>
        </div>
      );
    case "more":
      return (
        <div className={cn(base, "cursor-default text-body-sm text-cf-text-muted")} data-testid="search-row" data-kind="more" data-thread={row.group.threadId}>
          <span className="w-12 shrink-0" />
          {moreLabel(row.count)}
        </div>
      );
    case "note":
      return (
        <div className="flex h-full items-center px-3 text-caption text-cf-text-muted" data-testid="search-note">
          {row.text}
        </div>
      );
  }
});

/**
 * The dialog's results, virtualized (TanStack Virtual, fixed row heights). The selected
 * row is kept in view; a pointer that moves over a name or hit selects it (as the
 * palette's rows do), a click activates any row but a heading or note.
 */
export function SearchList({ rows, selected, onSelect, onActivate }: { rows: readonly SearchRow[]; selected: string; onSelect: (key: string) => void; onActivate: (row: SearchRow) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: (i) => SEARCH_ROW_HEIGHT[rows[i]?.kind ?? "hit"],
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 12,
    paddingStart: 4,
    paddingEnd: 8,
  });
  useEffect(() => {
    v.measure();
  }, [v, rows]);
  useEffect(() => {
    const i = rows.findIndex((r) => r.key === selected);
    if (i < 0) return;
    // The thread's header above its first hit comes into view with it.
    const prev = rows[i - 1];
    v.scrollToIndex(prev?.kind === "group" || prev?.kind === "section" ? i - 1 : i, { align: "auto" });
  }, [selected, rows, v]);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-2" role="listbox" aria-label="Results" data-testid="search-list">
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          const pickable = row.kind === "name" || row.kind === "hit";
          const clickable = pickable || row.kind === "group" || row.kind === "more";
          return (
            <div
              key={row.key}
              role={pickable ? "option" : undefined}
              aria-selected={pickable ? row.key === selected : undefined}
              style={{ position: "absolute", top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${String(vi.start)}px)` }}
              onPointerMove={
                pickable && row.key !== selected
                  ? () => {
                      onSelect(row.key);
                    }
                  : undefined
              }
              onMouseDown={(e) => {
                // Keep the keyboard in the query field.
                e.preventDefault();
              }}
              onClick={
                clickable
                  ? () => {
                      onActivate(row);
                    }
                  : undefined
              }
            >
              <Row row={row} selected={row.key === selected} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
