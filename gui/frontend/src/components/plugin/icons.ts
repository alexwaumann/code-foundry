/**
 * The lucide icons a plugin may name, in kebab case, PRIMITIVES.md §A "glyph": all of them
 * and their aliases (`trash-2`), the same names as `ui.Icons` in pluginsdk
 * (scripts/pluginIcons.ts writes that list). A name lucide lacks draws a circle.
 */
import * as lucide from "lucide-react";
import { Circle, Puzzle, type LucideIcon } from "lucide-react";

/** lucide's capitalised exports that are not icons. */
const NOT_ICONS = new Set(["Icon", "LucideProvider"]);

/** `trash-2` to `Trash2`: lucide's export for a kebab name. */
function exportName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** The lucide icon of a kebab name, undefined when there is none. */
export function iconByName(name: string): LucideIcon | undefined {
  const key = exportName(name);
  if (NOT_ICONS.has(key) || !/^[A-Z]/.test(key) || !Object.hasOwn(lucide, key)) return undefined;
  return lucide[key as keyof typeof lucide] as LucideIcon;
}

/** A plugin's icon by name: the lucide icon, else a circle (undefined name: `fallback`). */
export function pluginIcon(name: string | undefined, fallback: LucideIcon = Puzzle): LucideIcon {
  if (!name) return fallback;
  return iconByName(name) ?? Circle;
}
