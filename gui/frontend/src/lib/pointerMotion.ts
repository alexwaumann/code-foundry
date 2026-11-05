/**
 * Whether the pointermove being dispatched is the pointer really moving. WebKit sends a
 * trusted pointermove after a layout change with the mouse at rest, so a list that selects
 * on hover would jump to whatever slid under the pointer. That event repeats the last
 * position exactly; movementX is no help (0 for real moves too in the app's WebKit).
 *
 * The position is kept for the whole window, not per list: a list that has just opened
 * under a resting pointer sees this event first and has nothing of its own to compare.
 */
let last: { x: number; y: number } | null = null;
let moved = true;

function track(e: PointerEvent) {
  moved = last === null || e.clientX !== last.x || e.clientY !== last.y;
  last = { x: e.clientX, y: e.clientY };
}

// Capture on the window runs before any list's handler for the same event.
window.addEventListener("pointermove", track, { capture: true, passive: true });

/** For a pointermove handler: false when this event did not change the pointer's position. */
export function pointerMoved(): boolean {
  return moved;
}
