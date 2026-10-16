/**
 * The design tokens that are class names, for code that has to know them (cn()'s merge
 * table in lib/utils.ts, the tests). index.css defines them; src/design/roles.test.ts fails
 * when the two lists differ. docs/notes/design-system-1-tokens.md has the values.
 */

/** Block type roles: `text-<role>` sets size, line-height, weight (tracking) and colour. */
export const TYPE_ROLES = ["title", "heading", "subheading", "overline", "body", "body-sm", "label", "caption", "caption-sm"] as const;

/** Inline type roles: weight, colour or family only; they keep the surrounding size. */
export const INLINE_TYPE_ROLES = ["link", "code"] as const;

/** Radius names beyond Tailwind's (`rounded-pane`, `rounded-t-pane`, ...). */
export const RADIUS_NAMES = ["pane"] as const;

/** Spacing names beyond Tailwind's (`m-shell`, `gap-shell`, ...). */
export const SPACING_NAMES = ["shell"] as const;
