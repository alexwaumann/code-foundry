import { cn } from "@/lib/utils";
import type { TagKind } from "@/lib/prompt";

/**
 * The accent of a text tag, as `--chip-accent`: a theme token, so it follows the scheme.
 * Image chips sample theirs from the thumbnail; PDF chips use the file accent (AttachmentChip).
 */
export const TAG_ACCENT: Record<Exclude<TagKind, "image">, string> = {
  skill: "[--chip-accent:var(--highlight)]",
  file: "[--chip-accent:var(--info)]",
};

/**
 * Every tag's box: rounded, a 1px border and a fill tinted with `--chip-accent`,
 * text-body-sm at 1.41em height; selected tags get the selection highlight over them.
 */
export function tagClass(selected: boolean, extra?: string): string {
  return cn(
    "relative mx-px inline-flex h-[1.41em] max-w-72 items-center gap-[0.33em] rounded-md border px-[0.5em] align-middle text-body-sm leading-none font-medium select-none",
    "border-[color-mix(in_oklab,var(--chip-accent)_34%,var(--color-border))] bg-[color-mix(in_oklab,var(--chip-accent)_11%,transparent)] text-[color-mix(in_oklab,var(--chip-accent)_22%,var(--color-foreground))]",
    "hover:border-[color-mix(in_oklab,var(--chip-accent)_48%,var(--color-border))] hover:bg-[color-mix(in_oklab,var(--chip-accent)_17%,transparent)]",
    selected && "after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-[Highlight]/30",
    extra,
  );
}
