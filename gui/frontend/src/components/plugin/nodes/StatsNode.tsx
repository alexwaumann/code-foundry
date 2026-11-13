import { useState } from "react";
import { FigureCard } from "@/components/charts/FigureCard";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useRunAction } from "../actions";
import { figureRole, statCardWidth, statsColumns, statToneClass } from "../charts";
import { useViewCtx } from "../context";
import { useElementWidth } from "../layout";
import { InlineLine } from "../parts";
import type { NodeProps } from "../registry";

/**
 * A row of figure cards, the Pull Requests page's (docs/notes/plugin-stats-bars.md): one
 * row while every card fits at 100 px, else balanced rows (charts.ts statsColumns); the
 * figures take the largest type role whose estimate of the widest value fits a card
 * (display in a wide pane, title at most in a narrow one), so a value
 * never wraps. A card with an
 * action is a toggle; while one is pressed the others dim, as the page's filter cards do.
 */
export function StatsNode({ node, data }: NodeProps<"stats">) {
  const run = useRunAction();
  const { inert } = useViewCtx();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(el);
  const cards = data.cards;
  const columns = statsColumns(width, cards.length);
  const role = width === null ? "text-title" : figureRole(width, statCardWidth(width, columns), cards.map((c) => c.value));
  const anyPressed = cards.some((c) => c.action !== undefined && c.pressed);
  return (
    <div
      ref={setEl}
      className="grid min-w-0 shrink-0 gap-3"
      style={{ gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` }}
      data-testid="plugin-stats"
      data-key={node.key}
      data-columns={columns}
      data-role={role}
    >
      {cards.map((c) => {
        const toggle = c.action !== undefined;
        const pressed = toggle && (c.pressed ?? false);
        return (
          <FigureCard
            key={c.key}
            label={
              <Tip label={c.label} whenTruncated>
                <span className="block truncate">{c.label}</span>
              </Tip>
            }
            figure={
              <Tip label={c.value} whenTruncated>
                <span className="block truncate">{c.value}</span>
              </Tip>
            }
            subtitle={c.subtitle === undefined ? undefined : <InlineLine value={c.subtitle} className="block" />}
            figureClassName={cn(role, statToneClass(c.tone))}
            pressed={pressed}
            dimmed={anyPressed}
            disabled={toggle ? inert : undefined}
            onPress={
              toggle
                ? () => {
                    run(c.key, c.action);
                  }
                : undefined
            }
            data-testid="plugin-stat"
            data-key={c.key}
            data-tone={c.tone || undefined}
            data-pressed={pressed || undefined}
            figureProps={{ "data-testid": "plugin-stat-value" }}
          />
        );
      })}
    </div>
  );
}
