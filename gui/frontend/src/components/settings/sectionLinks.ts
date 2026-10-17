import type { ComponentType } from "react";
import { BrowseThemesRow } from "./LinkRow";

/**
 * Link rows at the end of a section's card, by "<page>/<section>": a section that leads
 * to a page of its own registers here.
 */
export const sectionLinks: Readonly<Partial<Record<string, ComponentType<{ className?: string | undefined }>>>> = {
  "appearance/theme": BrowseThemesRow,
};
