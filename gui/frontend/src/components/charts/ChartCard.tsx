import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A chart's card (the Pull Requests activity charts, plugin bar charts): a bordered box
 * with a one-line header (an optional lead such as a series key, the title, a muted
 * subtitle that gives way first, and an optional trailing figure on the right) over the
 * plot.
 */
export function ChartCard({
  title,
  subtitle,
  lead,
  trailing,
  heading: Heading = "h2",
  className,
  children,
  ...rest
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  lead?: ReactNode;
  trailing?: ReactNode;
  heading?: "h2" | "h3";
} & ComponentProps<"section">) {
  const header = title !== undefined || subtitle !== undefined || trailing !== undefined || lead !== undefined;
  return (
    <section className={cn("min-w-0 rounded-lg border px-4 py-3", className)} {...rest}>
      {header && (
        <div className="mb-1.5 flex min-w-0 items-center">
          {lead}
          {title !== undefined && <Heading className="shrink-0 text-label font-medium">{title}</Heading>}
          {subtitle !== undefined && <span className={cn("min-w-0 truncate text-label font-normal text-cf-text-muted", title !== undefined && "ml-2")}>{subtitle}</span>}
          {trailing !== undefined && <span className="ml-auto shrink-0 pl-3 text-caption tabular-nums">{trailing}</span>}
        </div>
      )}
      {children}
    </section>
  );
}
