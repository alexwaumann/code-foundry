import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { tooltipSide, tooltipStyle } from "./tooltip";

/**
 * A chart's one host-drawn tooltip (the Pull Requests activity charts, plugin bar
 * charts): an overlay card beside point `index` of `n`, anchored at `x` px in a plot
 * `width` px wide, `top` px down; it never takes the pointer. Its parent is the plot's
 * relative box.
 */
export function ChartTooltip({
  index,
  n,
  x,
  width,
  top,
  gap,
  className,
  ...rest
}: { index: number; n: number; x: number; width: number; top: number; gap?: number } & Omit<ComponentProps<"div">, "style">) {
  return (
    <div
      className={cn("pointer-events-none absolute z-10 min-w-40 rounded-lg border border-cf-border bg-cf-surface-overlay px-2.5 py-2 text-caption-sm text-cf-text shadow-lg", className)}
      style={tooltipStyle(index, n, x, width, top, gap)}
      data-side={tooltipSide(index, n)}
      {...rest}
    />
  );
}
