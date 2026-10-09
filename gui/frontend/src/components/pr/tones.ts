import type { Tone } from "./model";

/** Text colour per tone, readable on the pane in both schemes. */
export const toneText: Record<Tone | "skipped", string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  failure: "text-red-600 dark:text-red-400",
  pending: "text-amber-600 dark:text-amber-300",
  merged: "text-violet-600 dark:text-violet-400",
  draft: "text-muted-foreground",
  neutral: "text-muted-foreground",
  skipped: "text-muted-foreground",
};

/** Badge (border + tint) per tone. */
export const toneBadge: Record<Tone, string> = {
  success: "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-400",
  failure: "border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-400/30 dark:text-red-400",
  pending: "border-amber-600/30 bg-amber-500/10 text-amber-700 dark:border-amber-300/30 dark:text-amber-300",
  merged: "border-violet-600/30 bg-violet-500/10 text-violet-700 dark:border-violet-400/30 dark:text-violet-400",
  draft: "border-border bg-muted/60 text-muted-foreground",
  neutral: "border-border bg-muted/60 text-muted-foreground",
};
