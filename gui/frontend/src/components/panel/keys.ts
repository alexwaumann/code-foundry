import { surfaceByHotkey, type SurfaceContext } from "@/surfaces/registry";
import { isPicking, type PanelEntry, type Tab } from "@/stores/panel";

/**
 * Whether a chord is the panel's own: cmd+w, a bare letter some surface uses as its
 * hotkey (whether or not that surface is enabled now), and Escape while `picking` (the
 * surface list shows instead of a surface). SurfaceSpec.onKey never sees these. Escape
 * is the panel's only while picking: surfaces use it (closing a popup, cancelling an ask).
 */
export function isPanelChord(chord: string, picking = false): boolean {
  return chord === "cmd+w" || (picking && chord === "escape") || (/^[a-z]$/.test(chord) && surfaceByHotkey(chord) !== undefined);
}

export type PanelKeyAction = { kind: "close"; tabId: string } | { kind: "hide" } | { kind: "stopPicking" } | { kind: "open"; tab: Tab };

/**
 * What a key does while focus is inside the side panel: cmd+w closes the active tab, or
 * hides the panel when it has none (so cmd+w is always handled while the panel has
 * focus); while picking (the "+" was clicked) cmd+w and Escape go back to the tab that
 * was active instead; a surface's bare hotkey letter opens its default tab when the
 * surface is enabled. Anything else (and disabled or hidden surfaces) is null. The
 * caller skips letters typed into text fields.
 */
export function panelKeyAction(chord: string, entry: PanelEntry, ctx: SurfaceContext): PanelKeyAction | null {
  if (isPicking(entry) && (chord === "cmd+w" || chord === "escape")) return { kind: "stopPicking" };
  if (chord === "cmd+w") return entry.activeTabId === null ? { kind: "hide" } : { kind: "close", tabId: entry.activeTabId };
  if (!/^[a-z]$/.test(chord)) return null;
  const spec = surfaceByHotkey(chord);
  if (!spec || spec.available(ctx) !== "enabled") return null;
  const tab = spec.openDefault(ctx);
  return tab ? { kind: "open", tab } : null;
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
