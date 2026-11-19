import { createContext } from "react";

/**
 * Whether the rows under it take part in the sidebar's multi-selection (docs/notes/sidebar-bulk-select.md):
 * the expanded list's ThreadListbox provides true; the rail's lists do not, so their rows never
 * show it.
 */
export const MultiSelectEnabled = createContext(false);

/** The modifier keys a row's click carries (a React mouse event has them). */
export interface ClickMods {
  metaKey: boolean;
  shiftKey: boolean;
}
