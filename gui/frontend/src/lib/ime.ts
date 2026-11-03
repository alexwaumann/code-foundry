/** The keyCode of a keydown an input method processes. */
const IME_KEY_CODE = 229;

/**
 * Whether a keydown belongs to an input method (a candidate being picked or confirmed).
 * WebKit fires compositionend before the Enter that confirms a candidate, so that keydown
 * has isComposing false; its keyCode is still 229. Pass the native event's fields.
 */
export function imeKeyDown(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === IME_KEY_CODE;
}
