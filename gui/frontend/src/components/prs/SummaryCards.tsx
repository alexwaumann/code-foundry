import { FigureCard } from "@/components/charts/FigureCard";
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
            <FigureCard
              key={c.section}
              label={c.label}
              figure={c.count}
              subtitle={c.subtitle}
              figureClassName={cn("text-display-sm", c.warn ? "text-cf-warning-text" : empty && "text-cf-text-muted")}
              pressed={selected}
              dimmed={filter !== null}
              empty={empty}
              onPress={() => {
                onToggle(c.section);
              }}
              data-testid={`prs-card-${c.section}`}
              data-selected={selected || undefined}
              figureProps={{ "data-testid": "prs-card-count" }}
              subtitleProps={{ "data-testid": "prs-card-subtitle" }}
            />
          );
        })}
      </div>
    </div>
  );
}
