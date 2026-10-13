import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A small muted chip: the thread tooltip's "worktree" and "no git", the thread header's
 * "worktree" after the branch. Text only, never interactive.
 */
export function Chip({ children, className, ...props }: { children: ReactNode; className?: string; "aria-label"?: string; "data-testid"?: string }) {
  return (
    <span className={cn("shrink-0 rounded-[3px] bg-foreground/8 px-1 text-[10px] leading-4 font-medium text-muted-foreground", className)} {...props}>
      {children}
    </span>
  );
}
