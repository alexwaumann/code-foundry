import type { IFunctionIdentifier, Terminal } from "@xterm/xterm";

/**
 * Terminal queries the daemon's libghostty emulator already answers (vt.go, and
 * libghostty's built-in replies). xterm.js answers them too, through onData, so every
 * attached viewer would write a second, late reply into the PTY as if typed. When it
 * lands while the program's tty is still in cooked mode (Claude Code at startup), the tty
 * echoes it and `^[[?1;2c` shows up on screen. Swallowing them here leaves exactly one
 * reply, from the daemon, which also answers when no GUI is attached.
 *
 * OSC 10/11/12 color queries are the same, and a late reply does more harm there: a
 * program sends OSC 11 and then a cursor position query as a sentinel, stops reading at the
 * sentinel's reply, and the shell gets the color as typed text. The daemon has the theme
 * (UiService.PublishTheme) so its reply comes first. See docs/notes/terminal-color-replies.md.
 *
 * Not swallowed: focus reports (user events, not replies). See
 * docs/notes/terminal-shift-enter.md.
 */
export const DAEMON_ANSWERED_CSI: readonly IFunctionIdentifier[] = [
  { final: "c" }, // DA1
  { prefix: ">", final: "c" }, // DA2
  { final: "n" }, // DSR: status, cursor position
  { prefix: "?", final: "n" }, // DSR private: DECXCPR
  { intermediates: "$", final: "p" }, // DECRQM, ANSI modes
  { prefix: "?", intermediates: "$", final: "p" }, // DECRQM, DEC private modes
];

/** DECRQSS (DCS $ q ... ST). */
export const DAEMON_ANSWERED_DCS: readonly IFunctionIdentifier[] = [{ intermediates: "$", final: "q" }];

/**
 * True when an OSC 4 payload ("index;spec;index;spec...") only queries ("?"). The daemon
 * answers palette queries; sets must still reach xterm (snapshots replay the palette).
 */
export function isPaletteQueryOnly(data: string): boolean {
  const parts = data.split(";");
  if (parts.length < 2 || parts.length % 2 !== 0) return false;
  for (let i = 1; i < parts.length; i += 2) if (parts[i] !== "?") return false;
  return true;
}

/**
 * True when an OSC 10/11/12 payload only queries ("?", or "?;?" asking for the next
 * dynamic colors too). Sets must still reach xterm: a program may repaint the background.
 */
export function isColorQueryOnly(data: string): boolean {
  return data.split(";").every((part) => part === "?");
}

/** Registers handlers that consume the daemon-answered queries before xterm replies. */
export function swallowDaemonAnsweredQueries(term: Terminal): { dispose(): void }[] {
  const p = term.parser;
  return [
    ...DAEMON_ANSWERED_CSI.map((id) => p.registerCsiHandler(id, () => true)),
    ...DAEMON_ANSWERED_DCS.map((id) => p.registerDcsHandler(id, () => true)),
    p.registerOscHandler(4, (data) => isPaletteQueryOnly(data)),
    ...[10, 11, 12].map((ident) => p.registerOscHandler(ident, (data) => isColorQueryOnly(data))),
  ];
}
