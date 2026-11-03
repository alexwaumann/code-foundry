import { useState, type ReactNode } from "react";
import { SearchIcon } from "lucide-react";
import type { SearchModeProps } from "./FindSearch";
import { SEARCH_MODES, type SearchMode } from "./modes";

/** The header: a search icon, the query field, what the mode puts beside it (the "Aa" badge), and the mode switch when there are several. */
function SearchHeader({ query, setQuery, badges }: { query: string; setQuery: (q: string) => void; badges: ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4" data-testid="search-header">
      <SearchIcon className="size-4 shrink-0 text-cf-text-muted" aria-hidden />
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        placeholder="Search threads and messages…"
        aria-label="Search threads"
        spellCheck={false}
        autoComplete="off"
        className="h-10 min-w-0 flex-1 bg-transparent text-body outline-hidden placeholder:text-cf-placeholder"
        data-testid="search-input"
      />
      {badges}
    </div>
  );
}

/**
 * The cross-thread search dialog (search.open, cmd+shift+f;
 * docs/notes/search-4-find-dialog.md): a page of the palette's chrome, wider, with a query
 * field over the current mode's body. Remounted on every open (fresh query).
 */
export function SearchDialog({ modes = SEARCH_MODES, ...seams }: { modes?: readonly SearchMode[] } & Pick<SearchModeProps, "search" | "loaders">) {
  const [query, setQuery] = useState("");
  const [modeId] = useState(modes[0]?.id ?? "");
  const mode = modes.find((m) => m.id === modeId) ?? modes[0];
  if (!mode) return null;
  const { Body } = mode;
  return (
    <div className="flex h-[min(620px,calc(86vh/var(--cf-zoom)-2rem))] flex-col" data-testid="search-dialog" data-mode={mode.id}>
      <Body query={query} header={(badges) => <SearchHeader query={query} setQuery={setQuery} badges={badges} />} {...seams} />
    </div>
  );
}
