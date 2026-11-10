import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A small muted chip: the thread hover card's "no git"; the theme gallery's sample. Text only,
 * never interactive.
 */
export function Chip({ children, className, ...props }: { children: ReactNode; className?: string; "aria-label"?: string; "data-testid"?: string }) {
  return (
    <span className={cn("shrink-0 rounded-sm bg-cf-text/8 px-1 text-caption-sm font-medium", className)} {...props}>
      {children}
    </span>
  );
}
