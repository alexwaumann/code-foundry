import type { ITheme } from "@xterm/xterm";
import { themes } from "@/themes";
import { contrast, flatten, over, parseHex, toHex } from "@/themes/color";
import { resolveSlots, type ThemeFile } from "@/themes/slots";

/**
 * xterm ITheme keys and the CSS variables on <html> they come from (the active theme's
 * slots, set by lib/theme.ts; src/themes/slots.ts). The background is the surface (--cf-surface):
 * the terminal is part of its pane.
 */
const VARS: readonly (readonly [keyof ITheme, string])[] = [
  ["background", "--cf-surface"],
  ["foreground", "--terminal-fg"],
  ["cursor", "--terminal-cursor"],
  ["cursorAccent", "--terminal-cursor-accent"],
  ["selectionBackground", "--terminal-selection"],
  ["selectionInactiveBackground", "--terminal-selection-inactive"],
  ["black", "--terminal-ansi-0"],
  ["red", "--terminal-ansi-1"],
  ["green", "--terminal-ansi-2"],
  ["yellow", "--terminal-ansi-3"],
  ["blue", "--terminal-ansi-4"],
  ["magenta", "--terminal-ansi-5"],
  ["cyan", "--terminal-ansi-6"],
  ["white", "--terminal-ansi-7"],
  ["brightBlack", "--terminal-ansi-8"],
  ["brightRed", "--terminal-ansi-9"],
  ["brightGreen", "--terminal-ansi-10"],
  ["brightYellow", "--terminal-ansi-11"],
  ["brightBlue", "--terminal-ansi-12"],
  ["brightMagenta", "--terminal-ansi-13"],
  ["brightCyan", "--terminal-ansi-14"],
  ["brightWhite", "--terminal-ansi-15"],
];

/**
 * The terminal palette as the document's CSS variables currently resolve it. A variable
 * that is unset (or empty, as under jsdom) is left out, so xterm keeps its default.
 */
export function terminalTheme(root: Element = document.documentElement): ITheme {
  const style = getComputedStyle(root);
  const theme: Record<string, string> = {};
  for (const [key, name] of VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value) theme[key] = value;
  }
  return theme;
}

/** Whether two palettes are the same colours (a re-read after an unrelated change). */
export function sameTheme(a: ITheme | undefined, b: ITheme): boolean {
  if (!a) return false;
  return VARS.every(([key]) => a[key] === b[key]);
}

/** The find's colours as #RRGGBB, what xterm's decorations take: every match, the current one, the current one's outline. */
export interface FindColors {
  match: string;
  active: string;
  border: string;
}

/** How strong the current match's tint and every match's start, of the warning colour over the surface. */
const ACTIVE_TINT = 0.6;
const MATCH_TINT = 0.26;
/** What the foreground should keep on a tint: 4.5:1, or most of what it has on the surface where that is less (Solarized). */
const TEXT_CONTRAST = 4.5;
const TEXT_CONTRAST_KEPT = 0.8;

/**
 * The warning colour over the surface, as the thread's find tints its matches, opaque
 * because a decoration replaces the cell's background. A cell's text keeps its colour, so
 * the current match's tint backs off until the terminal's foreground reads on it, which on
 * a muted theme is well before a solid fill, and every other match stays at most half of it.
 */
export function findColors(surface: string, warning: string, foreground: string): FindColors {
  const under = toHex(parseHex(surface).rgb);
  const border = flatten(warning, under);
  const text = flatten(foreground, under);
  const floor = Math.min(TEXT_CONTRAST, contrast(text, under) * TEXT_CONTRAST_KEPT);
  let strength = ACTIVE_TINT;
  while (strength > 0.1 && contrast(text, over(border, strength, under)) < floor) strength -= 0.02;
  return { match: over(border, Math.min(MATCH_TINT, strength / 2), under), active: over(border, strength, under), border };
}

const fromSlots = (read: (name: string) => string | undefined) => findColors(read("--cf-surface") ?? "", read("--cf-warning") ?? "", read("--terminal-fg") ?? "");

/** The find's colours for the active theme; with no theme on the document (jsdom), the catalog's first. */
export function terminalFindColors(root: Element = document.documentElement): FindColors {
  const style = getComputedStyle(root);
  try {
    return fromSlots((name) => style.getPropertyValue(name).trim());
  } catch {
    const slots = resolveSlots(themes[0] as ThemeFile);
    return fromSlots((name) => slots[name]);
  }
}

/**
 * Calls `onChange` with the new palette whenever something on <html> that can change it
 * changes: the `dark` class (lib/theme.ts), `data-theme`, or inline variables. Watching
 * the document rather than the React scheme means the palette is read after the class
 * flips, whatever order the scheme listeners run in.
 */
export function watchTerminalTheme(onChange: (theme: ITheme) => void): () => void {
  const root = document.documentElement;
  const warning = () => getComputedStyle(root).getPropertyValue("--cf-warning").trim();
  let current = terminalTheme(root);
  // Not in the palette, but the find's colours are made from it (terminalFindColors).
  let currentWarning = warning();
  const mo = new MutationObserver(() => {
    const next = terminalTheme(root);
    const nextWarning = warning();
    if (sameTheme(current, next) && currentWarning === nextWarning) return;
    current = next;
    currentWarning = nextWarning;
    onChange(next);
  });
  mo.observe(root, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  return () => {
    mo.disconnect();
  };
}
