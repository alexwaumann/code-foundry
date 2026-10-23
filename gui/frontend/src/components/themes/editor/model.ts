/**
 * The theme editor's labels (docs/notes/theme-editor.md): each base colour's name, what it
 * paints and the slot it feeds first; a slot's short name; and the pure helpers the views
 * use (the page's columns by width, the hex field's input, the plane's gamut edge). View-only
 * data, no state.
 */
import type { BaseKey } from "@/stores/themeEditor";
import { oklchRgb } from "@/themes/color";

export interface BaseMeta {
  readonly label: string;
  /** What it paints, in a few words (the row's second line). */
  readonly hint: string;
  /** The slot it becomes (through its rule): whose contrast pairs the base view lists. */
  readonly slot: string;
}

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

export const TONE_KEYS = ["success", "warning", "error", "info", "highlight"] as const;

export const BASE_META: Readonly<Record<string, BaseMeta>> = {
  canvas: { label: "Canvas", hint: "window, sidebar, title band", slot: "--cf-canvas" },
  surface: { label: "Surface", hint: "panes and the terminal", slot: "--cf-surface" },
  text: { label: "Text", hint: "body text, held at 7:1", slot: "--cf-text" },
  accent: { label: "Accent", hint: "primary buttons, focus, your bubble", slot: "--cf-accent" },
  success: { label: "Success", hint: "finished, added, passing", slot: "--cf-success" },
  warning: { label: "Warning", hint: "attention, modified", slot: "--cf-warning" },
  error: { label: "Error", hint: "failed, deleted, destructive", slot: "--cf-error" },
  info: { label: "Info", hint: "working, links when no link is set", slot: "--cf-info" },
  highlight: { label: "Highlight", hint: "asked, highlights, charts", slot: "--cf-highlight" },
  link: { label: "Link", hint: "links", slot: "--cf-link" },
  "terminal.foreground": { label: "Foreground", hint: "terminal text, code", slot: "--terminal-fg" },
  "terminal.cursor": { label: "Cursor", hint: "the terminal cursor", slot: "--terminal-cursor" },
  "terminal.cursorText": { label: "Cursor text", hint: "the character under the cursor", slot: "--terminal-cursor-accent" },
  "terminal.selection": { label: "Selection", hint: "selected terminal text", slot: "--terminal-selection" },
  ...Object.fromEntries(
    Array.from({ length: 16 }, (_, n) => [`terminal.ansi.${String(n)}`, { label: `ANSI ${String(n)}`, hint: `${n >= 8 ? "bright " : ""}${ANSI[n % 8] ?? ""}`, slot: `--terminal-ansi-${String(n)}` }]),
  ),
};

export function baseMeta(key: BaseKey): BaseMeta {
  return BASE_META[key] ?? { label: key, hint: "", slot: "" };
}

/** A slot's name without the `--cf-` prefix (the terminal and syntax names keep theirs, minus the dashes). */
export const shortName = (slot: string): string => slot.replace(/^--cf-/, "").replace(/^--/, "");

/** A contrast ratio as the editor prints it, rounded down so a failing one never reads as its floor: "3.9:1", "1.27:1" under 2. */
export const ratioText = (r: number): string => (r < 2 ? `${(Math.floor(r * 100) / 100).toFixed(2)}:1` : `${(Math.floor(r * 10) / 10).toFixed(1)}:1`);

/** The base key of ANSI colour n. */
export const ansiKey = (n: number): BaseKey => `terminal.ansi.${String(n)}` as BaseKey;

/** The picker plane's chroma axis: 0 to about the most any sRGB colour reaches. */
export const C_MAX = 0.37;

/** What the picker's hex field takes: `#rrggbb` (with or without the #, any case), `#rgb` expanded, and `#rrggbbaa` for a tint; null for anything else. */
export function parseHexInput(raw: string, tint?: boolean): string | null {
  let t = raw.trim().toLowerCase();
  if (!t.startsWith("#")) t = `#${t}`;
  if (/^#[0-9a-f]{3}$/.test(t)) t = t.replace(/[0-9a-f]/g, (c) => c + c);
  return /^#[0-9a-f]{6}$/.test(t) || (tint && /^#[0-9a-f]{8}$/.test(t)) ? t : null;
}

/** The most chroma sRGB has at this OKLCH lightness and hue: the edge of the picker plane's painted part. */
export function maxChroma(l: number, h: number): number {
  if (oklchRgb(l, C_MAX, h)) return C_MAX;
  let lo = 0;
  let hi = C_MAX;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (oklchRgb(l, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The Themes page body's columns while the editor is open, by the body's width: the list
 * (240px, a 56px strip of the themes' Aa chips, or none), the inspector (340px or 296px),
 * and the rest for the edit bar and the gallery. The gallery is 640px at its widest and
 * scrolls sideways below that; the edit bar wraps; neither leaves the page down to the
 * window's minimum (900px: a body of about 590px beside the sidebar).
 */
export function editorLayout(width: number): { readonly list: "full" | "strip" | "hidden"; readonly inspector: number } {
  const inspector = width >= 1000 ? 340 : 296;
  if (width >= 240 + inspector + 640) return { list: "full", inspector };
  if (width >= 56 + inspector + 200) return { list: "strip", inspector };
  return { list: "hidden", inspector };
}
