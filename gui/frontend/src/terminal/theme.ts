import type { ITheme } from "@xterm/xterm";

/**
 * xterm ITheme keys and the CSS variables on <html> they come from (src/index.css,
 * `:root` and `.dark`). The background is --pane: the terminal is part of its pane.
 */
const VARS: readonly (readonly [keyof ITheme, string])[] = [
  ["background", "--pane"],
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

/**
 * Calls `onChange` with the new palette whenever something on <html> that can change it
 * changes: the `dark` class (lib/theme.ts), `data-theme`, or inline variables. Watching
 * the document rather than the React scheme means the palette is read after the class
 * flips, whatever order the scheme listeners run in.
 */
export function watchTerminalTheme(onChange: (theme: ITheme) => void): () => void {
  const root = document.documentElement;
  let current = terminalTheme(root);
  const mo = new MutationObserver(() => {
    const next = terminalTheme(root);
    if (sameTheme(current, next)) return;
    current = next;
    onChange(next);
  });
  mo.observe(root, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  return () => {
    mo.disconnect();
  };
}
