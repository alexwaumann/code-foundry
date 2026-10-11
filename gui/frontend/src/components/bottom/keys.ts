/** What cmd+w does while the bottom panel has focus. */
export type BottomKeyAction = { kind: "close"; terminalId: string } | { kind: "hide" };

/**
 * The bottom panel's own keys: cmd+w closes the active terminal, or hides the panel when
 * it has no tabs (so cmd+w is always handled while the panel has focus). Anything else is
 * null: the terminal (or the app's keybindings) gets it.
 */
export function bottomKeyAction(chord: string, activeTerminalId: string | null): BottomKeyAction | null {
  if (chord !== "cmd+w") return null;
  return activeTerminalId === null ? { kind: "hide" } : { kind: "close", terminalId: activeTerminalId };
}

/**
 * Where Left/Right/Home/End move focus in a strip of `count` tabs from `index`: Left and
 * Right wrap. null for any other key, or an empty strip.
 */
export function tabFocusIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
