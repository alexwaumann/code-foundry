import { surfaceByHotkey, type SurfaceContext } from "@/surfaces/registry";
import type { PanelEntry, Tab } from "@/stores/panel";

export type PanelKeyAction = { kind: "close"; tabId: string } | { kind: "open"; tab: Tab };

/**
 * What a key does while focus is inside the side panel (outside text fields): cmd+w
 * closes the active tab; a surface's bare hotkey letter opens its default tab when the
 * surface is enabled. Anything else (and disabled or hidden surfaces) is null.
 */
export function panelKeyAction(chord: string, entry: PanelEntry, ctx: SurfaceContext): PanelKeyAction | null {
  if (chord === "cmd+w") return entry.activeTabId === null ? null : { kind: "close", tabId: entry.activeTabId };
  if (!/^[a-z]$/.test(chord)) return null;
  const spec = surfaceByHotkey(chord);
  if (!spec || spec.available(ctx) !== "enabled") return null;
  const tab = spec.openDefault(ctx);
  return tab ? { kind: "open", tab } : null;
}
