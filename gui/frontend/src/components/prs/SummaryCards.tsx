import { cn } from "@/lib/utils";
import type { Card, Section } from "./pageModel";

/**
 * The five counts under the charts. A click shows only that card's section (the card
 * selected, the others dimmed); a second click, or Escape on the page, shows them all
 * again. A card with nothing to show is muted and disabled.
 */
export function SummaryCards({ cards, filter, rows, onToggle }: { cards: readonly Card[]; filter: Section | null; rows: (s: Section) => number; onToggle: (s: Section) => void }) {
  return (
    <div className="@container" data-testid="prs-cards">
      <div className="grid grid-cols-5 gap-3 @max-[640px]:grid-cols-3">
        {cards.map((c) => {
          const empty = rows(c.section) === 0;
          const selected = filter === c.section;
          return (
            <button
              key={c.section}
              type="button"
              disabled={empty}
              aria-pressed={selected}
              onClick={() => {
                onToggle(c.section);
              }}
              className={cn(
                "flex min-w-0 flex-col items-start rounded-lg border px-3.5 py-3 text-left transition-[opacity,border-color]",
                selected ? "border-cf-text ring-1 ring-cf-text" : "enabled:hover:border-cf-border-strong",
                filter !== null && !selected && "opacity-50 enabled:hover:opacity-100",
                empty && "opacity-60",
              )}
              data-testid={`prs-card-${c.section}`}
              data-selected={selected || undefined}
            >
              <span className="w-full truncate text-label font-normal text-cf-text-muted">{c.label}</span>
              <span className={cn("text-display-sm", c.warn ? "text-cf-warning-text" : empty && "text-cf-text-muted")} data-testid="prs-card-count">
                {c.count}
              </span>
              <span className="w-full truncate text-caption" data-testid="prs-card-subtitle">
                {c.subtitle}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
