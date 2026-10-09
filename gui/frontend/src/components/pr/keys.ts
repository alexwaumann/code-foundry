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

/** Never wider than the room Radix measured inside the collision boundary (less its padding). */
export const POPUP_FIT = "max-w-[calc(var(--radix-popper-available-width)-8px)]";
export const POPUP_COLLISION_PADDING = 8;

/**
 * The ask composer's keys: Enter sends, Shift+Enter is a newline, Escape cancels. Enter
 * while an input method is composing belongs to the IME.
 */
export function composerKeyAction(e: { key: string; shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean }): "send" | "cancel" | null {
  if (e.isComposing) return null;
  if (e.key === "Escape") return "cancel";
  if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey) return "send";
  return null;
}
