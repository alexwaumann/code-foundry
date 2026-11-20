import type { ComponentProps } from "react";
import { ChevronRight } from "lucide-react";
import type { SettingFieldView } from "@/api/settings";
import { useFieldUnused } from "./fieldUnused";
import { LinkRow } from "./LinkRow";
import type { PageSectionHit, SearchResult } from "./model";
import { SettingRow } from "./SettingRow";

/**
 * A hit's row. One its parent leaves unused now (a switch that is off, another value) dims and
 * says why, as the hit is away from its parent; it stays editable, ready for when it is used.
 */
function HitRow({ parent, ...row }: ComponentProps<typeof SettingRow> & { parent: SettingFieldView | undefined }) {
  const { unused, reason } = useFieldUnused(row.field, parent);
  return <SettingRow {...row} dimmed={unused} note={reason} />;
}

/**
 * The search with text: one flat card of every match across the pages, each under a
 * "Page › Section" breadcrumb, with the key shown and the words marked. Keybindings show
 * as full rows here (title, description, key), so the card has one kind of row. Sections of
 * the GUI's own pages (Skills) follow as link rows that open the page at the section.
 */
export function SearchResults({
  query,
  words,
  result,
  sections = [],
  onOpenSection,
  back,
}: {
  query: string;
  words: readonly string[];
  result: SearchResult;
  sections?: readonly PageSectionHit[];
  onOpenSection?: (pageId: string, sectionId: string) => void;
  back: string;
}) {
  const n = result.hits.length + sections.length;
  return (
    <div data-testid="settings-results">
      <div className="mb-3 flex items-baseline gap-2" data-testid="settings-result-count">
        <h2 className="text-heading">
          {n} {n === 1 ? "result" : "results"}
        </h2>{" "}
        <span className="text-caption">for “{query}” across all settings</span>
      </div>
      {n === 0 ? (
        <p className="py-8 text-center text-body text-cf-text-muted">No settings match “{query}”.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-cf-border">
          {result.hits.map(({ field, parent, page, section }, i) => (
            <HitRow
              key={field.key}
              field={field}
              parent={parent}
              words={words}
              className={i > 0 ? "border-t border-cf-border" : undefined}
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
          {sections.map(({ page, section }, i) => (
            <LinkRow
              key={`${page.id}/${section.id}`}
              label={section.title ? `${page.title} › ${section.title}` : page.title}
              description={section.description}
              className={result.hits.length + i > 0 ? "border-t border-cf-border" : undefined}
              testId="settings-section-hit"
              onClick={() => {
                onOpenSection?.(page.id, section.id);
              }}
            />
          ))}
        </div>
      )}
      <p className="mt-2.5 text-caption-sm">Esc clears the search and returns to {back}.</p>
    </div>
  );
}
