import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tooltip";
import { firstSelectable, keepSelection, moveSelection, searchRows, selectable, type SearchRow } from "@/lib/threadSearch";
import { imeKeyDown } from "@/lib/ime";
import { activateSearchRow } from "@/stores/threadSearch";
import { SearchList } from "./SearchList";
import type { PreviewSubject } from "./preview";
import { SearchPreview } from "./SearchPreview";
import { previewKey, useSearchPreview, useThreadSearch, type PreviewLoaders, type PreviewTarget, type SearchFn } from "./useSearch";

/** What a mode gets from the dialog: the query and the header to draw (the shared field, with what the mode puts beside it). */
export interface SearchModeProps {
  query: string;
  header: (badges: ReactNode) => ReactNode;
  /** Test seams: the daemon's Search and the preview's reads. */
  search?: SearchFn;
  loaders?: PreviewLoaders;
}

function previewOf(row: SearchRow | undefined): { target: PreviewTarget; subject: PreviewSubject } | null {
  if (row?.kind === "hit") {
    const h = row.hit;
    return {
      target: { kind: "hit", threadId: h.threadId, itemId: h.itemId, ordinal: h.ordinal, withPrompt: h.speaker !== "user" },
      subject: { kind: "hit", threadId: h.threadId, threadName: row.group.threadName, archived: row.group.archived, atMs: h.createdAtMs, speaker: h.speaker },
    };
  }
  if (row?.kind === "name") {
    const n = row.name;
    return { target: { kind: "thread", threadId: n.threadId }, subject: { kind: "thread", threadId: n.threadId, threadName: n.name, archived: n.archived, atMs: n.lastActivityMs } };
  }
  return null;
}

/** The footer's key hints; Enter's words follow the selected row. */
function Hints({ row }: { row: SearchRow | undefined }) {
  return (
    <div className="flex shrink-0 items-center gap-4 border-t px-4 py-2 text-caption text-cf-text-muted" data-testid="search-hints">
      <span className="flex items-center gap-1.5">
        <Kbd size="sm">⏎</Kbd>
        {row?.kind === "name" ? "open thread" : "open at message"}
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd size="sm">↑</Kbd>
        <Kbd size="sm">↓</Kbd>
        move
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd size="sm">esc</Kbd>
        close
      </span>
    </div>
  );
}

/**
 * Before a query, or when nothing matches: a short hint. (PR 6 adds Recent searches to
 * the empty state and a "Try Agent search" row to no results, here.)
 */
function SearchEmpty({ query, searching }: { query: string; searching: boolean }) {
  const text =
    query === ""
      ? "Search every thread's name and messages: yours, Claude's text and answered questions. A capital letter makes it case-sensitive."
      : searching
        ? "Searching…"
        : `No threads or messages match “${query}”.`;
  return (
    <p className="px-5 py-6 text-body-sm text-cf-text-muted" data-testid="search-empty">
      {text}
    </p>
  );
}

/**
 * The Find mode (search.open; docs/notes/search-4-find-dialog.md): live results as the
 * user types (ThreadService.Search), thread names then messages grouped by thread, on the
 * left; the selected row's message on the right. Arrow keys move through names and hits,
 * Enter opens the selected one: a hit in its thread with the thread's find bar on the same
 * match. Enter before the typed query's answer waits for it, then opens its first row.
 */
export function FindSearch({ query: raw, header, search, loaders }: SearchModeProps) {
  const query = raw.trim();
  const state = useThreadSearch(query, search);
  const answered = state.answered === query;
  const rows = useMemo(() => (query !== "" && state.result ? searchRows(state.result) : []), [query, state.result]);

  // The selection: the first row of each new query's answer, else where the keys or pointer put it.
  const [selected, setSelected] = useState("");
  const shownQuery = useRef("");
  useEffect(() => {
    const same = shownQuery.current === state.answered;
    shownQuery.current = state.answered;
    setSelected((cur) => keepSelection(rows, cur, same));
  }, [rows, state.answered]);
  const row = rows.find((r) => r.key === selected);
  const preview = previewOf(row);
  const data = useSearchPreview(preview?.target ?? null, loaders);
  // Until the row's data arrives the preview shows its crumb and nothing under it.
  const shownData = data && preview && data.key === previewKey(preview.target) ? data : null;

  // Enter while the typed query is not answered yet: opens the answer's first row when it arrives.
  const pending = useRef<string | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (p === null) return;
    if (p !== query) {
      pending.current = null;
      return;
    }
    if (!answered) return;
    pending.current = null;
    const first = rows.find((r) => r.key === firstSelectable(rows));
    if (first) activateSearchRow(first, query);
  }, [answered, rows, query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys an input method takes (WebKit's confirming Enter has isComposing false, keyCode 229).
    if (imeKeyDown(e.nativeEvent)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.ctrlKey && (e.key === "n" || e.key === "p"))) {
      e.preventDefault();
      setSelected((cur) => moveSelection(rows, cur, e.key === "ArrowDown" || e.key === "n" ? 1 : -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (query === "") return;
      if (!answered) {
        pending.current = query;
        return;
      }
      if (row && selectable(row)) activateSearchRow(row, query);
    }
  };

  // Smart case is the daemon's: shown from its answer, as long as it answers the typed query.
  const caseBadge = answered && state.result?.caseSensitive ? (
    <Tip label="Case-sensitive: the query has a capital letter">
      <span className="shrink-0 rounded-sm bg-cf-accent-surface px-1.5 text-caption-sm text-cf-accent-surface-foreground" data-testid="search-case">
        Aa
      </span>
    </Tip>
  ) : null;

  const hasRows = rows.some((r) => r.kind === "name" || r.kind === "group");
  // Only a note (names only, nothing matched): the hint, then the note.
  const note = hasRows ? null : rows.find((r): r is Extract<SearchRow, { kind: "note" }> => r.kind === "note");
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown} data-testid="search-find">
      {header(caseBadge)}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[min(440px,45%)] shrink-0 flex-col border-r">
          {state.error && answered && (
            <p className="px-5 pt-3 text-caption text-cf-error-text" role="alert" data-testid="search-error">
              Cannot search: {state.error}
            </p>
          )}
          {hasRows ? (
            <SearchList
              rows={rows}
              selected={selected}
              onSelect={setSelected}
              onActivate={(r) => {
                // The rows answer state.answered, which lags the typed query while a newer search is out.
                activateSearchRow(r, state.answered);
              }}
            />
          ) : (
            !state.error && <SearchEmpty query={query} searching={query !== "" && !answered} />
          )}
          {note && (
            <p className="px-5 text-caption text-cf-text-muted" data-testid="search-note">
              {note.text}
            </p>
          )}
        </div>
        {preview ? <SearchPreview subject={preview.subject} data={shownData} query={state.answered} /> : <div className="min-w-0 flex-1" data-testid="search-preview-none" />}
      </div>
      <Hints row={row} />
    </div>
  );
}
