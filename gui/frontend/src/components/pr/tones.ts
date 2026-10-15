import type { PrStateTone } from "@/components/prs/prState";
import type { Tone } from "./model";

/**
 * The PR surfaces' tone → class tables (the Pull Requests page, the PR panel, the thread
 * header and the worktree overview all read these). Colours are the theme's status
 * tokens (index.css), so one class follows both schemes and any imported theme.
 */

/** Text colour per tone, readable on the pane in both schemes. */
export const toneText: Record<Tone | "skipped", string> = {
  success: "text-success",
  failure: "text-destructive",
  pending: "text-warning",
  merged: "text-highlight",
  draft: "text-muted-foreground",
  neutral: "text-muted-foreground",
  skipped: "text-muted-foreground",
};

/** A pull request's state colour (prState.ts: open, merged, closed; draft and unknown muted). */
export const prStateText: Record<PrStateTone, string> = {
  emerald: toneText.success,
  violet: toneText.merged,
  red: toneText.failure,
  muted: toneText.neutral,
};

/** Badge (border + tint) per tone. */
export const toneBadge: Record<Tone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  failure: "border-destructive/30 bg-destructive/10 text-destructive",
  pending: "border-warning/30 bg-warning/10 text-warning",
  merged: "border-highlight/30 bg-highlight/10 text-highlight",
  draft: "border-border bg-muted/60 text-muted-foreground",
  neutral: "border-border bg-muted/60 text-muted-foreground",
};
