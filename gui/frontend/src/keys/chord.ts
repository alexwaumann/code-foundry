/**
 * Keyboard chords in the daemon's keybinding syntax: "cmd+k", "cmd+shift+p",
 * "ctrl+alt+enter". Modifiers: cmd (meta/command/⌘), ctrl (control/⌃),
 * alt (opt/option/⌥), shift (⇧). The final segment is the key.
 */

export interface Chord {
  key: string;
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const modifierAliases: Record<string, keyof Omit<Chord, "key">> = {
  cmd: "cmd",
  meta: "cmd",
  command: "cmd",
  super: "cmd",
  "⌘": "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  "⌃": "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  "⌥": "alt",
  shift: "shift",
  "⇧": "shift",
};

const keyAliases: Record<string, string> = {
  esc: "escape",
  return: "enter",
  "↵": "enter",
  del: "delete",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  "↑": "arrowup",
  "↓": "arrowdown",
  "←": "arrowleft",
  "→": "arrowright",
  plus: "=",
  minus: "-",
  comma: ",",
  period: ".",
  slash: "/",
  " ": "space",
  spacebar: "space",
};

function normalizeKey(k: string): string {
  const lower = k.toLowerCase();
  return keyAliases[lower] ?? lower;
}

/** Parses a chord string. Returns null for malformed input (empty key, unknown modifier). */
export function parseChord(input: string): Chord | null {
  const s = input.trim();
  if (!s) return null;
  // "cmd++" means cmd and the "+" key.
  const parts = s.endsWith("++") ? [...s.slice(0, -2).split("+"), "+"] : s.split("+");
  const key = parts.pop();
  if (key === undefined || key.trim() === "") return null;
  const chord: Chord = { key: normalizeKey(key.trim()), cmd: false, ctrl: false, alt: false, shift: false };
  for (const raw of parts) {
    const mod = modifierAliases[raw.trim().toLowerCase()];
    if (!mod) return null;
    chord[mod] = true;
  }
  return chord;
}

/** Canonical string: modifiers in cmd, ctrl, alt, shift order, then the key. */
export function chordToString(c: Chord): string {
  const mods = [c.cmd && "cmd", c.ctrl && "ctrl", c.alt && "alt", c.shift && "shift"].filter(Boolean);
  return [...mods, c.key].join("+");
}

/** Canonicalizes a chord string, or null if it does not parse. */
export function normalizeChord(input: string): string | null {
  const c = parseChord(input);
  return c ? chordToString(c) : null;
}

const codeKeys: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Space: "space",
};

/** Physical key name for an event. Uses `code` for letters/digits/punctuation so
 * option- and shift-modified characters ("π", "!") still match "alt+p", "shift+1". */
export function eventKey(e: Pick<KeyboardEvent, "key" | "code">): string {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  const mapped = codeKeys[code];
  if (mapped) return mapped;
  return normalizeKey(e.key);
}

const modifierKeys = new Set(["meta", "control", "alt", "shift", "capslock", "fn", "os"]);

/** Chord for a keydown event, or null for a bare modifier press. */
export function chordFromEvent(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string | null {
  const key = eventKey(e);
  if (!key || modifierKeys.has(key)) return null;
  return chordToString({ key, cmd: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
}

const keyGlyphs: Record<string, string> = {
  enter: "↵",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  space: "Space",
};

/** Display form for a chord, macOS style: "⌃⌥⇧⌘P". Returns the input if it does not parse. */
export function formatChord(input: string): string {
  const c = parseChord(input);
  if (!c) return input;
  const key = keyGlyphs[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key.charAt(0).toUpperCase() + c.key.slice(1));
  return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.cmd ? "⌘" : ""}${key}`;
}

/** Clipboard and editing chords: always left to the focused terminal or text field. */
const editingChords = new Set(["cmd+c", "cmd+v", "cmd+x", "cmd+a", "cmd+z", "cmd+shift+z"]);

/** True for a normalized clipboard/editing chord (never bindable). */
export function isEditingChord(chord: string): boolean {
  return editingChords.has(chord);
}

/**
 * True for a normalized chord that a focused terminal yields to the app when a command is
 * bound to it: cmd-modified (macOS terminals never send cmd chords to the PTY) and not a
 * clipboard/editing chord.
 */
export function terminalYieldable(chord: string): boolean {
  return chord.startsWith("cmd+") && !editingChords.has(chord);
}
