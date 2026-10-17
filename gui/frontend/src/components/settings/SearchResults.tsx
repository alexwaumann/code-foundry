import { ChevronRight } from "lucide-react";
import type { SearchResult } from "./model";
import { SettingRow } from "./SettingRow";

/**
 * The search with text: one flat card of every match across the pages, each under a
 * "Page › Section" breadcrumb, with the key shown and the words marked. Keybindings show
 * as full rows here (title, description, key), so the card has one kind of row.
 */
export function SearchResults({ query, words, result, back }: { query: string; words: readonly string[]; result: SearchResult; back: string }) {
  const n = result.hits.length;
  return (
    <div data-testid="settings-results">
      <div className="mb-3 flex items-baseline gap-2" data-testid="settings-result-count">
        <h2 className="text-heading">
          {n} {n === 1 ? "result" : "results"}
        </h2>
        <span className="text-caption">for “{query}” in every page</span>
      </div>
      {n === 0 ? (
        <p className="py-8 text-center text-body text-muted-foreground">No settings match “{query}”.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {result.hits.map(({ field, page, section }, i) => (
            <SettingRow
              key={field.key}
              field={field}
              words={words}
              className={i > 0 ? "border-t border-border" : undefined}
              crumb={
                <div className="mb-0.5 flex items-center gap-1 text-caption-sm" data-testid="setting-crumb">
                  {page.title}
                  {section?.title && (
                    <>
                      <ChevronRight className="size-3" aria-hidden />
                      <span className="sr-only"> › </span>
                      {section.title}
                    </>
                  )}
                </div>
              }
            />
          ))}
        </div>
      )}
      <p className="mt-2.5 text-caption-sm">Esc clears the search and returns to {back}.</p>
    </div>
  );
}
