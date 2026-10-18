import { Quote } from "lucide-react";

/** The quote glyph of a citation chip (the composer's and the bubble's), in the chip's accent. */
export function QuoteGlyph() {
  return <Quote aria-hidden className="size-[0.92em] shrink-0 fill-current stroke-0 text-[color-mix(in_oklab,var(--chip-accent)_70%,var(--color-foreground))]" />;
}
