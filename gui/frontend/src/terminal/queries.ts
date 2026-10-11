import type { IFunctionIdentifier, Terminal } from "@xterm/xterm";

/**
 * Terminal queries the daemon's libghostty emulator already answers (vt.go, and
 * libghostty's built-in replies). xterm.js answers them too, through onData, so every
 * attached viewer would write a second, late reply into the PTY as if typed. When it
 * lands while the program's tty is still in cooked mode (Claude Code at startup), the tty
 * echoes it and `^[[?1;2c` shows up on screen. Swallowing them here leaves exactly one
 * reply, from the daemon, which also answers when no GUI is attached.
 *
 * Not swallowed: OSC 10/11/12 color queries (the daemon's emulator has no default
 * foreground/background, so xterm's theme reply is the only one) and focus reports
 * (user events, not replies). See docs/notes/terminal-shift-enter.md.
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

/** Registers handlers that consume the daemon-answered queries before xterm replies. */
export function swallowDaemonAnsweredQueries(term: Terminal): { dispose(): void }[] {
  const p = term.parser;
  return [
    ...DAEMON_ANSWERED_CSI.map((id) => p.registerCsiHandler(id, () => true)),
    ...DAEMON_ANSWERED_DCS.map((id) => p.registerDcsHandler(id, () => true)),
    p.registerOscHandler(4, (data) => isPaletteQueryOnly(data)),
  ];
}
