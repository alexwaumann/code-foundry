import type { PrStateTone } from "@/components/prs/prState";
import type { Tone } from "./model";

/**
 * The PR surfaces' tone → class tables (the Pull Requests page, the PR panel, the thread
 * header and the worktree overview all read these). Colours are the theme's status
 * tokens (index.css), so one class follows both schemes and any imported theme.
 */

/** Text colour per tone, readable on the pane in both schemes. */
export const toneText: Record<Tone | "skipped", string> = {
  success: "text-cf-success",
  failure: "text-cf-error",
  pending: "text-cf-warning",
  merged: "text-cf-highlight",
  draft: "text-cf-text-muted",
  neutral: "text-cf-text-muted",
  skipped: "text-cf-text-muted",
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
  success: "border-cf-success/30 bg-cf-success-surface text-cf-success",
  failure: "border-cf-error/30 bg-cf-error-surface text-cf-error",
  pending: "border-cf-warning/30 bg-cf-warning-surface text-cf-warning",
  merged: "border-cf-highlight/30 bg-cf-highlight-surface text-cf-highlight",
  draft: "border-cf-border bg-cf-surface-sunken/60 text-cf-text-muted",
  neutral: "border-cf-border bg-cf-surface-sunken/60 text-cf-text-muted",
};
