import { useEffect, useMemo } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import type { CompareView } from "@/api/compare";
import { HeaderAction } from "@/components/files/FileHeader";
import { RowList, VIRTUALIZE_OVER } from "@/components/prs/RowList";
import { Input } from "@/components/ui/input";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import { cn } from "@/lib/utils";
import { filterRows, stepRow, statusColor, TOP_ROWS, topListFit, type FileRow } from "./files";

export const ROW_H = 30;
/** More files than this and the list offers a filter: as many as fit without scrolling. */
const FILTER_OVER = { rail: 20, top: TOP_ROWS } as const;

/** A file: status letter, name, directory (cut from the left), lines added and deleted. The tooltip is what the row hides. */
function FileLine({ row }: { row: FileRow }) {
  return (
    <NavRow
      navKey={row.key}
      activateOnClick
      tip={row.oldPath ? `${row.oldPath} → ${row.path}` : row.path}
      // A rename's source is not on the row; a plain path only hides when it is cut short.
      tipWhenTruncated={!row.oldPath}
      className="flex h-full min-w-0 items-center gap-2 px-1.5 text-body-sm"
    >
      <span className={cn("w-3 shrink-0 text-center font-mono", statusColor[row.status] ?? "text-cf-text-muted")} data-status={row.status}>
        {row.status}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5" data-testid="file-path">
        <span className="max-w-full shrink-0 truncate" data-testid="file-name">
          {row.name}
        </span>
        {row.dir && <span className="min-w-0 truncate text-left text-caption-sm [direction:rtl]" data-testid="file-dir">{`‎${row.dir}‎`}</span>}
        {row.conflict && <span className="shrink-0 text-caption-sm text-cf-error-text">conflict</span>}
      </span>
      {(row.added > 0 || row.deleted > 0 || row.binary || row.submodule) && (
        <span className="flex shrink-0 gap-1.5 font-mono tabular-nums">
          {row.submodule ? (
            <span className="text-cf-text-muted">sub</span>
          ) : row.binary ? (
            <span className="text-cf-text-muted">bin</span>
          ) : (
            <>
              {row.added > 0 && <span className="text-cf-diff-addition" data-testid="file-added">{`+${String(row.added)}`}</span>}
              {row.deleted > 0 && <span className="text-cf-diff-deletion" data-testid="file-deleted">{`−${String(row.deleted)}`}</span>}
            </>
          )}
        </span>
      )}
    </NavRow>
  );
}

const rowKey = (r: FileRow): string => r.key;
const renderRow = (r: FileRow) => <FileLine row={r} />;

/**
 * The comparison's files: counts and "3 of 8" with previous and next, then the rows,
 * virtualized past RowList's limit. Clicking one shows that file; arrows and Enter do too
 * while the list has focus. As a rail it takes the height it is given; on top it fits what
 * the code leaves it (topListFit) and folds away, by itself when that is too little. Past a
 * screenful it offers a filter, which stays for as long as it is filtering. The filter and the
 * fold are the tab's (params), so they outlast it showing something else. `current` is the
 * file on screen when it is listed. The list keeps its place by file through live updates.
 */
export function FileList({
  view,
  rows,
  current,
  onPick,
  rail,
  height,
  query,
  onQuery,
  fold,
  onFold,
}: {
  view: CompareView;
  rows: readonly FileRow[];
  current: FileRow | null;
  onPick: (r: FileRow) => void;
  rail: boolean;
  /** The Diff tab's height, which the list on top is fitted to. */
  height: number;
  query: string;
  onQuery: (q: string) => void;
  /** The user's fold of the list on top, if any. */
  fold: boolean | undefined;
  onFold: (folded: boolean) => void;
}) {
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);
  const items = useMemo<NavItem[]>(
    () =>
      shown.map((r) => ({
        key: r.key,
        activate: () => {
          onPick(r);
        },
      })),
    [shown, onPick],
  );
  const nav = useNav(items);
  const { setCursor } = nav;
  const currentKey = current?.key ?? null;
  // When the file on screen changes, not when the list does: the cursor is the reader's.
  useEffect(() => {
    if (currentKey !== null) setCursor(currentKey);
  }, [currentKey, setCursor]);

  const at = current ? rows.findIndex((r) => r.key === current.key) : -1;
  const prev = stepRow(rows, current, -1);
  const next = stepRow(rows, current, 1);
  const filter = query !== "" || rows.length > (rail ? FILTER_OVER.rail : FILTER_OVER.top);
  const fit = topListFit(height, ROW_H, rows.length, filter);
  const folded = fold ?? fit.fold;
  const open = rail || !folded;
  const list = (
    <RowList rows={shown} rowKey={rowKey} rowHeight={ROW_H} render={renderRow} capped keepPlace virtualize={rows.length > VIRTUALIZE_OVER} maxHeight={rail ? "100%" : fit.rows * ROW_H} testId="diff-file-rows" />
  );
  return (
    <NavProvider value={nav.ctx}>
      <div
        tabIndex={0}
        role="listbox"
        aria-label="Changed files"
        aria-activedescendant={nav.activeDescendant}
        className={cn("flex min-h-0 flex-col outline-none", rail ? "w-[260px] shrink-0 border-r border-cf-divider" : "shrink-0 border-b border-cf-divider")}
        data-testid="diff-file-list"
        data-layout={rail ? "rail" : "top"}
        onKeyDown={nav.onKeyDown}
      >
        <div className="flex h-9 shrink-0 items-center gap-1.5 px-3 text-body-sm tabular-nums" data-testid="diff-totals">
          <span className="min-w-0 truncate">
            {view.totalFiles} {view.totalFiles === 1 ? "file" : "files"}
            {view.totalAdded > 0 && <span className="ml-1.5 text-cf-diff-addition">+{view.totalAdded}</span>}
            {view.totalDeleted > 0 && <span className="ml-1.5 text-cf-diff-deletion">−{view.totalDeleted}</span>}
          </span>
          <span className="ml-auto shrink-0 text-caption" data-testid="diff-position">
            {at >= 0 ? `${String(at + 1)} of ${String(rows.length)}` : ""}
          </span>
          <HeaderAction icon={ChevronLeft} label="Previous file" testId="diff-prev" onClick={() => { if (prev) onPick(prev); }} />
          <HeaderAction icon={ChevronRight} label="Next file" testId="diff-next" onClick={() => { if (next) onPick(next); }} />
          {!rail && <HeaderAction icon={folded ? ChevronDown : ChevronUp} label={folded ? "Show files" : "Hide files"} testId="diff-fold" onClick={() => { onFold(!folded); }} />}
        </div>
        {open && filter && (
          <div className="shrink-0 px-2 pb-1">
            <Input
              value={query}
              placeholder="Filter files"
              aria-label="Filter files"
              data-testid="diff-filter"
              className="h-7"
              onChange={(e) => {
                onQuery(e.target.value);
              }}
            />
          </div>
        )}
        {open && (rail ? <div className="relative min-h-0 flex-1"><div className="absolute inset-0 px-1.5">{list}</div></div> : <div className="px-1.5 pb-1">{list}</div>)}
        {open && query && shown.length === 0 && <p className="px-3 py-2 text-caption" data-testid="diff-filter-none">No files match</p>}
        {open && view.truncated && (
          <p className="shrink-0 border-t border-cf-divider px-3 py-1 text-caption-sm" data-testid="diff-truncated-list">
            First {view.files.length} of {view.totalFiles} files
          </p>
        )}
        {open && view.skippedNames > 0 && (
          <p className="shrink-0 border-t border-cf-divider px-3 py-1 text-caption-sm" data-testid="diff-skipped-names">
            {view.skippedNames === 1 ? "1 more file" : `${String(view.skippedNames)} more files`} not listed: {view.skippedNames === 1 ? "its name is" : "their names are"} not UTF-8
          </p>
        )}
      </div>
    </NavProvider>
  );
}
