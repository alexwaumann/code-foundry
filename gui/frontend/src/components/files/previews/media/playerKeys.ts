/**
 * The player's own keys, taken only while the keyboard is inside it (MediaPlayer's root is
 * `data-keys-local`, so the window's bare-key commands leave them alone there; chords with a
 * modifier are never the player's, so cmd+w, cmd+k and the rest still reach the keymap). Pure.
 */

export type PlayerAction = "toggle" | "back" | "forward" | "louder" | "quieter" | "mute" | "fullscreen";

/** How far Left and Right seek, in seconds. */
export const SEEK_STEP = 5;

const KEYS: Readonly<Record<string, PlayerAction>> = {
  " ": "toggle",
  ArrowLeft: "back",
  ArrowRight: "forward",
  ArrowUp: "louder",
  ArrowDown: "quieter",
  m: "mute",
  M: "mute",
  f: "fullscreen",
  F: "fullscreen",
};

/** The parts of a keydown the player looks at. */
export interface PlayerKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  isComposing?: boolean;
  target: EventTarget | null;
}

/**
 * The action a key in the player asks for, or null to leave it: anything with a modifier, a key
 * something inside already handled (a slider's Home and End), typing in a field, a menu's own
 * keys (the speed menu's type-ahead), and Space or Enter on a button (it presses that button).
 * F only where full screen is offered.
 */
export function playerKeyAction(e: PlayerKeyEvent, canFullscreen: boolean): PlayerAction | null {
  if (e.defaultPrevented || e.isComposing === true || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  const action = KEYS[e.key];
  if (action === undefined) return null;
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="menuitemradio"], [role="menuitem"]')) return null;
  if (e.key === " " && t?.closest("button")) return null;
  if (action === "fullscreen" && !canFullscreen) return null;
  return action;
}
