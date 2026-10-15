import { useCallback, useState, type KeyboardEvent } from "react";

/** The surface's copy-link chord (SurfaceSpec.onKey in surfaces/pullrequest.ts). */
export const COPY_LINK_CHORD = "cmd+shift+c";

/**
 * Keys inside portalled popups still bubble to the panel through React. Keep plain keys
 * (typeahead letters) from reaching its surface hotkeys; chords (cmd+w, shift+cmd+c) go on.
 */
export function stopPlainKeys(e: KeyboardEvent): void {
  if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
}

/**
 * Popups (menu, picker) stay inside the side panel: pass `ref` to the trigger and
 * `boundary` as the content's collisionBoundary, with POPUP_FIT in its className. The
 * panel is the trigger's [data-region="panel"] ancestor.
 */
export function usePanelBoundary(): { ref: (el: HTMLElement | null) => void; boundary: Element | null } {
  const [boundary, setBoundary] = useState<Element | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    setBoundary(el?.closest('[data-region="panel"]') ?? null);
  }, []);
  return { ref, boundary };
}

/**
 * Never wider than the room Radix measured inside the collision boundary (less its padding).
 * Radix measures in viewport px; the content is zoomed (index.css), so the room divides by --cf-zoom.
 */
export const POPUP_FIT = "max-w-[calc(var(--radix-popper-available-width)/var(--cf-zoom)-8px)]";
export const POPUP_COLLISION_PADDING = 8;

/** The keyCode of a keydown an input method processes. */
const IME_KEY_CODE = 229;

/**
 * The panel composers' keys. Escape cancels. `submit: "enter"` (the ask composer): Enter
 * (or cmd+Enter) sends and Shift+Enter is a newline. `submit: "cmd-enter"` (the review
 * composer, whose text is often several lines): only cmd+Enter sends and Enter is a
 * newline. Keys while an input method is composing belong to the IME. WebKit fires
 * compositionend before the Enter that confirms a candidate, so that keydown has
 * isComposing false; its keyCode is still 229 (pass the native event's keyCode).
 */
export function composerKeyAction(
  e: {
    key: string;
    shiftKey: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  },
  submit: "enter" | "cmd-enter" = "enter",
): "send" | "cancel" | null {
  if (e.isComposing || e.keyCode === IME_KEY_CODE) return null;
  if (e.key === "Escape") return "cancel";
  if (e.key !== "Enter" || e.shiftKey || e.altKey || e.ctrlKey) return null;
  if (submit === "cmd-enter" && !e.metaKey) return null;
  return "send";
}
