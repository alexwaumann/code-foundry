import { memo, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { lineRuns, TEXT_ROW_HEIGHT, type TextRow } from "@/lib/textSearch";
import { cn } from "@/lib/utils";
import "@/components/search/search.css";

/** A matching line: its number, then its text in the code font with every match tinted (search.css .search-hit). */
function MatchLine({ row, selected }: { row: Extract<TextRow, { kind: "match" }>; selected: boolean }) {
  const { runs, lead, trail } = useMemo(() => lineRuns(row.line), [row.line]);
  return (
    <div className={cn("flex h-full items-center gap-2.5 rounded-md px-3", selected && "bg-cf-control-hover")} data-testid="text-row" data-kind="match" data-line={row.line.line} data-path={row.file.path} data-selected={selected || undefined}>
      <span className="w-9 shrink-0 text-right text-code text-cf-text-muted tabular-nums" data-testid="text-row-line">
        {row.line.line}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-code whitespace-pre", selected ? "text-cf-text" : "text-cf-text-secondary")} data-testid="text-row-text">
        {lead && <span className="text-cf-text-muted">…</span>}
        {runs.map((r, i) =>
          r.hit ? (
            <mark key={i} className="search-hit" data-hit="">
              {r.text}
            </mark>
          ) : (
            <span key={i}>{r.text}</span>
          ),
        )}
        {trail && <span className="text-cf-text-muted">…</span>}
      </span>
    </div>
  );
}

/** One row: a file's header (name, directory cut from the left, project, ignored, count), a matching line, or the file's "N more" note. */
const Row = memo(function Row({ row, selected }: { row: TextRow; selected: boolean }) {
  switch (row.kind) {
    case "file":
      return (
        <div className="flex h-full items-end gap-2 px-3 pb-1" data-testid="text-row" data-kind="file" data-path={row.file.path} data-project={row.file.projectId}>
          <span className="max-w-[60%] shrink-0 truncate text-body-sm font-medium text-cf-text" data-testid="text-file-name">
            {row.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-caption text-cf-text-muted [direction:rtl]" data-testid="text-file-dir">
            {row.dir ? `‎${row.dir}‎` : ""}
          </span>
          {row.project !== null && (
            <span className="max-w-[30%] shrink-0 truncate text-caption text-cf-text-muted" data-testid="text-file-project">
              {row.project}
            </span>
          )}
          {row.file.ignored && (
            <span className="shrink-0 text-caption text-cf-text-muted" data-testid="text-file-ignored">
              ignored
            </span>
          )}
          <span className="shrink-0 text-caption text-cf-text-muted tabular-nums" data-testid="text-file-count">
            {row.count}
          </span>
        </div>
      );
    case "match":
      return <MatchLine row={row} selected={selected} />;
    case "more":
      return (
        <div className="flex h-full items-center pr-3 pl-[3.625rem] text-caption text-cf-text-muted" data-testid="text-row" data-kind="more" data-path={row.file.path}>
          {row.text}
        </div>
      );
  }
});

/**
 * The Text mode's results, virtualized (TanStack Virtual, fixed row heights): files in the
 * daemon's order, each with its matching lines. Only match rows take the selection, which is
 * kept in view with its file's header when it is the file's first; a pointer moving over a
 * match selects it, a click opens it. The keyboard stays in the query field.
 */
export function TextResults({ rows, selected, onSelect, onActivate }: { rows: readonly TextRow[]; selected: string; onSelect: (key: string) => void; onActivate: (row: Extract<TextRow, { kind: "match" }>) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: (i) => TEXT_ROW_HEIGHT[rows[i]?.kind ?? "match"],
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 16,
    paddingStart: 2,
    paddingEnd: 8,
  });
  useEffect(() => {
    v.measure();
  }, [v, rows]);
  useEffect(() => {
    const i = rows.findIndex((r) => r.key === selected);
    if (i < 0) return;
    // A file's first match comes into view with the file's header above it.
    const to = rows[i - 1]?.kind === "file" ? i - 1 : i;
    // The first row: the very top, its padding included (wrapping back from the last row lands here).
    if (to === 0) v.scrollToOffset(0);
    else v.scrollToIndex(to, { align: "auto" });
  }, [selected, rows, v]);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-2" role="listbox" aria-label="Matches" data-testid="text-list">
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          const match = row.kind === "match";
          return (
            <div
              key={row.key}
              role={match ? "option" : undefined}
              aria-selected={match ? row.key === selected : undefined}
              style={{ position: "absolute", top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${String(vi.start)}px)` }}
              onPointerMove={
                match && row.key !== selected
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
                match
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
