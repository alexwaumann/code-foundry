import { cn } from "@/lib/utils";
import type { Theme } from "@/themes";

/** The status colours a list row shows, in this order. */
const STRIP = ["--destructive", "--warning", "--success", "--info", "--primary"] as const;

/**
 * A theme's "Aa" sample: its foreground on its pane, framed by its pane border. Colours come
 * from the catalog's values (inline), not a scope, so a list of 14 costs nothing.
 */
export function ThemeAa({ theme, className }: { theme: Theme; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex h-5 w-7 shrink-0 items-center justify-center rounded border text-[11px] leading-none font-semibold", className)}
      style={{ background: theme.vars["--pane"], color: theme.vars["--foreground"], borderColor: theme.vars["--pane-border"] }}
    >
      Aa
    </span>
  );
}

/** Destructive, warning, success, info and primary as five joined swatches. */
export function ThemeStrip({ theme }: { theme: Theme }) {
  return (
    <span aria-hidden className="flex h-3 shrink-0 overflow-hidden rounded-sm" data-testid="theme-strip">
      {STRIP.map((k) => (
        <span key={k} className="w-2.5" style={{ background: theme.vars[k] }} />
      ))}
    </span>
  );
}
