/**
 * Whether the user's last input was a key rather than the pointer: a command started from a
 * chord or the palette's Enter may move focus into what it shows (the thread info overlay),
 * one started with a click leaves focus where it is. Installed once in App.
 */
let keyboard = false;

export function lastInputWasKeyboard(): boolean {
  return keyboard;
}

/** Tracks the last input (capture phase, ahead of every handler that may act on it). */
export function installInputModality(target: Window = window): () => void {
  const onKey = () => {
    keyboard = true;
  };
  const onPointer = () => {
    keyboard = false;
  };
  target.addEventListener("keydown", onKey, { capture: true });
  target.addEventListener("pointerdown", onPointer, { capture: true });
  return () => {
    target.removeEventListener("keydown", onKey, { capture: true });
    target.removeEventListener("pointerdown", onPointer, { capture: true });
    keyboard = false;
  };
}
