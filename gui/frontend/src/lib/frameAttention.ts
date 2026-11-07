/**
 * Whether the user is in a frame now (docs/notes/settings-user-only.md): the app has focus,
 * the frame has it too, and it came there by the pointer or Tab, or the pointer is over the
 * frame now. A frame that takes the focus for itself does not count.
 */

/** How soon after Tab a focus entering the frame is that Tab's. */
const TAB_MS = 200;

export interface FrameAttention {
  /** The user is in the frame now. */
  present: () => boolean;
  stop: () => void;
}

/** Watches the frame `frame` returns (the element changes when the page reloads). */
export function watchFrameAttention(frame: () => HTMLIFrameElement | null): FrameAttention {
  let entered = false;
  let tabAt = Number.NEGATIVE_INFINITY;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") tabAt = performance.now();
  };
  // The window's own blur (not in the capture phase, so no element's): focus went into a
  // frame, or to another app.
  const onBlur = () => {
    const el = frame();
    if (!el || !document.hasFocus() || document.activeElement !== el) return;
    entered = el.matches(":hover") || performance.now() - tabAt < TAB_MS;
  };
  const onFocus = () => {
    if (document.activeElement !== frame()) entered = false;
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus, true);
  return {
    present: () => {
      const el = frame();
      return el !== null && document.hasFocus() && document.activeElement === el && (entered || el.matches(":hover"));
    },
    stop: () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus, true);
    },
  };
}
