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
  const rgb = (slot: string): Rgb | null => {
    const v = vars[slot];
    if (!v) return null;
    const [r, g, b] = parseHex(flatten(v, surface)).rgb;
    return [r * 255, g * 255, b * 255];
  };
  const plate = rgb(SLOTS.plate);
  const edge = rgb(SLOTS.edge);
  const live = rgb(SLOTS.live);
  const hot = rgb(SLOTS.hot);
  const work = rgb(SLOTS.work);
  const err = rgb(SLOTS.err);
  return plate && edge && live && hot && work && err ? { plate, edge, live, hot, work, err } : null;
}
