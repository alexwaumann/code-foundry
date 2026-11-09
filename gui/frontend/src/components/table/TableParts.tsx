import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The parts of a bordered table that the Pull Requests page's tables and a plugin's Table
 * node share (docs/notes/plugin-table.md): the box, the overline header row, a row's grid,
 * a group's label row, and the heading over the table.
 */

/** A row's height (px); a dense plugin table's is DENSE_ROW_H. */
export const TABLE_ROW_H = 28;
export const DENSE_ROW_H = 24;

/** The bordered box around the header row and the rows. */
export const TABLE_BOX = "rounded-lg border";

/** The rows' list inside the box (the rows' hover tint keeps 2 px from the border). */
export const TABLE_BODY = "p-0.5";

/** A row: rounded, its cells 8 px from its edges. */
export const TABLE_ROW = "h-full rounded-md px-2 text-body";

/** The overline header row: one cell per shown column on the rows' grid template, lined up with the rows (px-2.5 = the rows' px-2 inside the body's p-0.5). */
export function TableHead({ template, className, children }: { template: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("grid gap-3 border-b px-2.5 py-1 text-overline", className)} style={{ gridTemplateColumns: template }}>
      {children}
    </div>
  );
}

/** A row's cells on the table's grid template. */
export function RowGrid({ template, children }: { template: string; children: ReactNode }) {
  return (
    <div className="grid h-full min-w-0 items-center gap-3" style={{ gridTemplateColumns: template }}>
      {children}
    </div>
  );
}

/**
 * A group's label in a grouped table: its name, its count, and a hairline to the edge (a
 * row's height, so a virtualized list keeps fixed rows). With `onToggle` it is a button
 * with a chevron that collapses the group (aria-expanded).
 */
export function GroupLabel({ name, count, testId, collapsed, onToggle }: { name: string; count: number; testId: string; collapsed?: boolean; onToggle?: () => void }) {
  const body = (
    <>
      {onToggle && <ChevronRight className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", !collapsed && "rotate-90")} aria-hidden />}
      <span className="truncate font-medium text-cf-text">{name}</span>
      <span className="shrink-0 tabular-nums">{count}</span>
      <span className="h-px flex-1 bg-cf-border" aria-hidden />
    </>
  );
  const cls = "flex h-full w-full items-center gap-2 px-2 pt-1.5 text-label text-cf-text-muted";
  if (!onToggle) {
    return (
      <div className={cls} data-testid={testId}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      className={cn(cls, "rounded-md text-left outline-none hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus")}
      data-testid={testId}
      data-collapsed={collapsed || undefined}
      onClick={onToggle}
    >
      {body}
    </button>
  );
}

/** A table's heading: its title and, in brackets, its count on one line however narrow (the title and count keep their width, the caption truncates). */
export function SectionTitle({
  children,
  count,
  caption,
  captionTestId,
  className,
}: {
  children: ReactNode;
  count?: number;
  /** Muted, after the count: "open, waiting on the author". */
  caption?: ReactNode;
  captionTestId?: string;
  className?: string;
}) {
  return (
    <h2 className={cn("mb-1.5 flex min-w-0 items-baseline gap-2 text-heading", className)}>
      <span className="shrink-0 whitespace-nowrap">{children}</span>
      {count !== undefined && <span className="shrink-0 text-caption tabular-nums">({count})</span>}
      {caption && (
        <span className="truncate text-caption" data-testid={captionTestId}>
          {caption}
        </span>
      )}
    </h2>
  );
}
