import { cn } from "@/lib/utils";
import type { TagKind } from "@/lib/prompt";
import type { PrStateTone } from "@/components/prs/prState";

/**
 * The accent of a text tag, as `--chip-accent`: a theme token, so it follows the scheme.
 * Image chips sample theirs from the thumbnail; PDF chips use the file accent (AttachmentChip).
 * A thread is sky leaning to cyan: `--cf-info` (the theme's sky) is the file accent already,
 * so the thread tag mixes in some `--cf-success` to tell the two apart. A pull request takes
 * its state's colour, as the PR rows show it (PR_ACCENT); this is the open one. A
 * citation is amber (`--cf-warning`), the tint its quote is painted in when re-highlighted.
 */
export const TAG_ACCENT: Record<Exclude<TagKind, "image">, string> = {
  skill: "[--chip-accent:var(--cf-highlight)]",
  file: "[--chip-accent:var(--cf-info)]",
  thread: "[--chip-accent:color-mix(in_oklab,var(--cf-info)_60%,var(--cf-success))]",
  pr: "[--chip-accent:var(--cf-success)]",
  cite: "[--chip-accent:var(--cf-warning)]",
};

/** A pull request tag's accent per state tone (components/prs/prState.ts): open, merged, closed, draft or unknown. */
export const PR_ACCENT: Record<PrStateTone, string> = {
  emerald: "[--chip-accent:var(--cf-success)]",
  violet: "[--chip-accent:var(--cf-highlight)]",
  red: "[--chip-accent:var(--cf-error)]",
  muted: "[--chip-accent:var(--cf-text-muted)]",
};

/**
 * Every tag's box: rounded, a 1px border and a fill tinted with `--chip-accent`,
 * text-body-sm at 1.41em height; selected tags get the selection highlight over them.
 */
export function tagClass(selected: boolean, extra?: string): string {
  return cn(
    "relative mx-px inline-flex h-[1.41em] max-w-72 items-center gap-[0.33em] rounded-md border px-[0.5em] align-middle text-body-sm leading-none font-medium select-none",
    "border-[color-mix(in_oklab,var(--chip-accent)_34%,var(--cf-border))] bg-[color-mix(in_oklab,var(--chip-accent)_11%,transparent)] text-[color-mix(in_oklab,var(--chip-accent)_22%,var(--cf-text))]",
    "hover:border-[color-mix(in_oklab,var(--chip-accent)_48%,var(--cf-border))] hover:bg-[color-mix(in_oklab,var(--chip-accent)_17%,transparent)]",
    selected && "after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-[Highlight]/30",
    extra,
  );
}
