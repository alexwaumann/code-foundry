import { surfaceByHotkey, type SurfaceContext } from "@/surfaces/registry";
import type { PanelEntry, Tab } from "@/stores/panel";

/**
 * Whether a chord is the panel's own: cmd+w, or a bare letter some surface uses as its
 * hotkey (whether or not that surface is enabled now). SurfaceSpec.onKey never sees these.
 */
export function isPanelChord(chord: string): boolean {
  return chord === "cmd+w" || (/^[a-z]$/.test(chord) && surfaceByHotkey(chord) !== undefined);
}

export type PanelKeyAction = { kind: "close"; tabId: string } | { kind: "hide" } | { kind: "open"; tab: Tab };

/**
 * What a key does while focus is inside the side panel: cmd+w closes the active tab, or
 * hides the panel when it has none (so cmd+w is always handled while the panel has
 * focus); a surface's bare hotkey letter opens its default tab when the surface is
 * enabled. Anything else (and disabled or hidden surfaces) is null. The caller skips
 * letters typed into text fields.
 */
export function panelKeyAction(chord: string, entry: PanelEntry, ctx: SurfaceContext): PanelKeyAction | null {
  if (chord === "cmd+w") return entry.activeTabId === null ? { kind: "hide" } : { kind: "close", tabId: entry.activeTabId };
  if (!/^[a-z]$/.test(chord)) return null;
  const spec = surfaceByHotkey(chord);
  if (!spec || spec.available(ctx) !== "enabled") return null;
  const tab = spec.openDefault(ctx);
  return tab ? { kind: "open", tab } : null;
}
