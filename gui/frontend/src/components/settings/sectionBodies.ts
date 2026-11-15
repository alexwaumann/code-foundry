import type { ComponentType } from "react";
import { IncludeIgnoredSection } from "./IncludeIgnoredSettings";
import type { SectionFields } from "./model";

/**
 * Sections drawn by a component of their own in place of their field rows, by
 * "<page>/<section>": a section that is one setting shaped as a list, headed by the
 * setting (General › Files: files.include_ignored's patterns). The search still finds the
 * field and shows its row (with its key editor).
 */
export const sectionBodies: Readonly<Partial<Record<string, ComponentType<{ section: SectionFields }>>>> = {
  "general/files": IncludeIgnoredSection,
};
