import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A chart's card (the Pull Requests activity charts, plugin bar charts): a bordered box
 * with a one-line header (an optional lead such as a series key, the title, a muted
 * subtitle that gives way first, and an optional trailing figure on the right) over the
 * plot.
 */
export function ChartCard({
  heading,
  subtitle,
  lead,
  trailing,
  as: Heading = "h2",
  className,
  children,
  ...rest
}: {
  /** The chart's name (not `title`: that is an element's native tooltip). */
  heading?: ReactNode;
  subtitle?: ReactNode;
  lead?: ReactNode;
  trailing?: ReactNode;
  /** The heading's element. */
  as?: "h2" | "h3";
} & ComponentProps<"section">) {
  const header = heading !== undefined || subtitle !== undefined || trailing !== undefined || lead !== undefined;
  return (
    <section className={cn("min-w-0 rounded-lg border px-4 py-3", className)} {...rest}>
      {header && (
        <div className="mb-1.5 flex min-w-0 items-center">
          {lead}
          {heading !== undefined && <Heading className="shrink-0 text-label font-medium">{heading}</Heading>}
          {subtitle !== undefined && <span className={cn("min-w-0 truncate text-label font-normal text-cf-text-muted", heading !== undefined && "ml-2")}>{subtitle}</span>}
          {trailing !== undefined && <span className="ml-auto shrink-0 pl-3 text-caption tabular-nums">{trailing}</span>}
        </div>
      )}
      {children}
    </section>
  );
}
