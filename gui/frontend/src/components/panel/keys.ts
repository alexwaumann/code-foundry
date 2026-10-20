import { surfaceByHotkey, type SurfaceContext } from "@/surfaces/registry";
import { groupAt, focusedGroup, isPicking, isSplit, type GroupIndex, type PanelEntry, type Tab } from "@/stores/panel";

/**
 * Moves focus to the other tab group of a split panel, whichever way the groups sit
 * (cmd+alt+\, next to view.panel.split's cmd+\). Reserved like cmd+w (internal/command
 * chord.go ReservedChords), since the panel takes it before the registry.
 */
export const FOCUS_OTHER_GROUP_CHORD = "cmd+alt+\\";

/**
 * Whether a chord is the panel's own: cmd+w, cmd+alt+\ (the other group), a bare letter
 * some surface uses as its hotkey (whether or not that surface is enabled now), and
 * Escape while `picking` (the surface list shows instead of a surface). SurfaceSpec.onKey
 * never sees these. Escape is the panel's only while picking: surfaces use it (closing a
 * popup, cancelling an ask).
 */
export function isPanelChord(chord: string, picking = false): boolean {
  return chord === "cmd+w" || chord === FOCUS_OTHER_GROUP_CHORD || (picking && chord === "escape") || (/^[a-z]$/.test(chord) && surfaceByHotkey(chord) !== undefined);
}

export type PanelKeyAction =
  | { kind: "close"; tabId: string }
  | { kind: "hide" }
  | { kind: "stopPicking" }
  | { kind: "open"; tab: Tab; group: GroupIndex }
  | { kind: "focusGroup"; group: GroupIndex };

/**
 * What a key does while focus is inside the side panel. It acts on the focused group
 * (focusedGroup): cmd+w closes its active tab, or hides the panel when it has none (so
 * cmd+w is always handled while the panel has focus); while it is picking (the "+" was
 * clicked) cmd+w and Escape go back to the tab that was active instead (or, for a split
 * panel's empty group, collapse the split); a surface's bare hotkey letter opens its
 * default tab in that group when the surface is enabled. On a split panel,
 * FOCUS_OTHER_GROUP_CHORD focuses the other group. Anything else (and disabled or hidden
 * surfaces) is null. The caller skips letters typed into text fields.
 */
export function panelKeyAction(chord: string, entry: PanelEntry, ctx: SurfaceContext): PanelKeyAction | null {
  const g = focusedGroup(entry);
  if (isPicking(entry, g) && (chord === "cmd+w" || chord === "escape")) return { kind: "stopPicking" };
  if (chord === "cmd+w") {
    const active = groupAt(entry, g).activeTabId;
    return active === null ? { kind: "hide" } : { kind: "close", tabId: active };
  }
  if (chord === FOCUS_OTHER_GROUP_CHORD) return isSplit(entry) ? { kind: "focusGroup", group: g === 0 ? 1 : 0 } : null;
  if (!/^[a-z]$/.test(chord)) return null;
  const spec = surfaceByHotkey(chord);
  if (!spec || spec.available(ctx) !== "enabled") return null;
  const tab = spec.openDefault(ctx);
  return tab ? { kind: "open", tab, group: g } : null;
}

/**
 * Where alt+Left / alt+Right on the tab at `index` (of `count`) moves it: one slot over,
 * clamped at the ends (no wrap), so at an end it stays at `index`. null for any other
 * chord, or an index outside the strip.
 */
export function tabMoveIndex(chord: string, index: number, count: number): number | null {
  const step = chord === "alt+arrowleft" ? -1 : chord === "alt+arrowright" ? 1 : 0;
  if (step === 0 || index < 0 || index >= count) return null;
  return Math.max(0, Math.min(count - 1, index + step));
}
