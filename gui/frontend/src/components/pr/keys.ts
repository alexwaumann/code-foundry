import type { KeyboardEvent } from "react";

/** The surface's copy-link chord (SurfaceSpec.onKey in surfaces/pullrequest.ts). */
export const COPY_LINK_CHORD = "cmd+shift+c";

/**
 * Keys inside portalled popups still bubble to the panel through React. Keep plain keys
 * (typeahead letters) from reaching its surface hotkeys; chords (cmd+w, shift+cmd+c) go on.
 */
export function stopPlainKeys(e: KeyboardEvent): void {
  if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
}
