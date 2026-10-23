/**
 * The theme editor's labels (docs/notes/theme-editor.md): each base colour's name, what it
 * paints and the slot it feeds first; a slot's short name. View-only data, no state.
 */
import type { BaseKey } from "@/stores/themeEditor";

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
