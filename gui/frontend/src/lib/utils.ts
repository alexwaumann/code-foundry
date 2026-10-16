import { createCn } from "cn/config";
import { INLINE_TYPE_ROLES, RADIUS_NAMES, SPACING_NAMES, TYPE_ROLES } from "@/design/tokens";

/**
 * clsx + tailwind-merge, taught the design tokens (src/design/tokens.ts). Without this,
 * `text-caption` reads as a text colour, so `cn("text-caption", "text-foreground")` would
 * drop the role. Block roles join the font-size group (a later role or size replaces them;
 * colour and weight utilities sit beside them), the inline roles get a group of their own,
 * and rounded-pane / *-shell join the radius and spacing scales.
 */
export const cn = createCn({
  extend: {
    theme: { text: [...TYPE_ROLES], radius: [...RADIUS_NAMES], spacing: [...SPACING_NAMES] },
    classGroups: { "type-inline": INLINE_TYPE_ROLES.map((r) => `text-${r}`) },
  },
});
