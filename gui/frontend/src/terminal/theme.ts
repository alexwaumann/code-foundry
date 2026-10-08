import type { ITheme } from "@xterm/xterm";
import type { ColorScheme } from "./renderer";

/** System font stack. JetBrains Mono when installed, else SF Mono (exposed to WebKit as
 * ui-monospace), else Menlo. No web font, so cell metrics are known at open time. */
export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", "SF Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';

// `background` is the pane colour: it must equal --pane in src/index.css (.dark and
// :root) so the terminal reads as part of the pane it sits in.
const dark: ITheme = {
  background: "#101010",
  foreground: "#d8dadf",
  cursor: "#e6e6e6",
  cursorAccent: "#101010",
  selectionBackground: "#3a4a6b",
  selectionInactiveBackground: "#2c3446",
  black: "#1d1f23",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#c8ccd4",
  brightBlack: "#5c6370",
  brightRed: "#ef8189",
  brightGreen: "#a9d38a",
  brightYellow: "#f0d08f",
  brightBlue: "#7cc0f7",
  brightMagenta: "#d68ff0",
  brightCyan: "#6fcbd6",
  brightWhite: "#f2f3f5",
};

const light: ITheme = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#24292f",
  cursorAccent: "#ffffff",
  selectionBackground: "#b6d3fb",
  selectionInactiveBackground: "#d7e5f8",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

export function terminalTheme(scheme: ColorScheme): ITheme {
  return scheme === "dark" ? dark : light;
}
