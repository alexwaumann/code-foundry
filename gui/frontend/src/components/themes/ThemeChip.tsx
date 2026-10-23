import { cn } from "@/lib/utils";
import type { Theme } from "@/themes";

/** The status colours a list row shows, in this order. */
const STRIP = ["--cf-error", "--cf-warning", "--cf-success", "--cf-info", "--cf-accent"] as const;

/**
 * A theme's "Aa" sample: its text on its surface, framed by its divider. Colours come
 * from the theme's resolved slots (inline), not a scope, so a list of 14 costs nothing.
 */
export function ThemeAa({ theme, className }: { theme: Theme; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex h-5 w-7 shrink-0 items-center justify-center rounded-sm border text-caption-sm leading-none font-semibold", className)}
      style={{ background: theme.slots["--cf-surface"], color: theme.slots["--cf-text"], borderColor: theme.slots["--cf-divider"] }}
    >
      Aa
    </span>
  );
}

/** Error, warning, success, info and the accent as five joined swatches. */
export function ThemeStrip({ theme, className }: { theme: Theme; className?: string }) {
  return (
    <span aria-hidden className={cn("flex h-3 shrink-0 overflow-hidden rounded-sm", className)} data-testid="theme-strip">
      {STRIP.map((k) => (
        <span key={k} className="w-2.5" style={{ background: theme.slots[k] }} />
      ))}
    </span>
  );
}
