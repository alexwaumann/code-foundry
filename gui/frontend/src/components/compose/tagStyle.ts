import { cn } from "@/lib/utils";
import type { TagKind } from "@/lib/prompt";

/**
 * The accent of a text tag, as `--chip-accent` (light / dark). Image chips sample theirs
 * from the thumbnail (AttachmentChip).
 */
export const TAG_ACCENT: Record<Exclude<TagKind, "image">, string> = {
  skill: "[--chip-accent:oklch(0.62_0.17_300)] dark:[--chip-accent:oklch(0.78_0.14_300)]",
  file: "[--chip-accent:oklch(0.6_0.14_230)] dark:[--chip-accent:oklch(0.78_0.12_230)]",
};

/**
 * Every tag's box: rounded, a 1px border and a fill tinted with `--chip-accent`, 0.86em
 * text at 1.41em height; selected tags get the selection highlight over them.
 */
export function tagClass(selected: boolean, extra?: string): string {
  return cn(
    "relative mx-px inline-flex h-[1.41em] max-w-72 items-center gap-[0.33em] rounded-[0.5em] border px-[0.5em] align-middle text-[0.86em] leading-none font-medium select-none",
    "border-[color-mix(in_oklab,var(--chip-accent)_34%,var(--color-border))] bg-[color-mix(in_oklab,var(--chip-accent)_11%,transparent)] text-[color-mix(in_oklab,var(--chip-accent)_22%,var(--color-foreground))]",
    "hover:border-[color-mix(in_oklab,var(--chip-accent)_48%,var(--color-border))] hover:bg-[color-mix(in_oklab,var(--chip-accent)_17%,transparent)]",
    selected && "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-[Highlight]/30",
    extra,
  );
}
