import { flatten, parseHex, type Rgb } from "@/themes/color";
import type { ScopeColours } from "./scope";

/** Which slot paints what (palette `accent` of the design). */
const SLOTS: Readonly<Record<keyof ScopeColours, string>> = {
  plate: "--cf-surface-overlay",
  edge: "--cf-divider",
  live: "--cf-accent",
  hot: "--cf-text",
  work: "--cf-info",
  err: "--cf-error",
};

/** The scope's colours from a theme's resolved slots, any tint flattened on the surface; null when one is missing. */
export function scopeColours(vars: Readonly<Record<string, string>>): ScopeColours | null {
  const surface = vars["--cf-surface"];
  if (!surface) return null;
  const slotColour = (slot: string): Rgb | null => {
    const v = vars[slot];
    if (!v) return null;
    const [r, g, b] = parseHex(flatten(v, surface)).rgb;
    return [r * 255, g * 255, b * 255];
  };
  const plate = slotColour(SLOTS.plate);
  const edge = slotColour(SLOTS.edge);
  const live = slotColour(SLOTS.live);
  const hot = slotColour(SLOTS.hot);
  const work = slotColour(SLOTS.work);
  const err = slotColour(SLOTS.err);
  return plate && edge && live && hot && work && err ? { plate, edge, live, hot, work, err } : null;
}
