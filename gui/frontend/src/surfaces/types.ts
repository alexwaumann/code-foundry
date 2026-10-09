import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { SurfaceKind, Tab } from "@/stores/panel";
import type { Selection } from "@/stores/ui";

/** Whether a surface can be opened for a selection: listed and clickable, dimmed, or not listed. */
export type SurfaceAvailability = "enabled" | "disabled" | "hidden";

/** What a surface sees when deciding availability and its default tab. */
export interface SurfaceContext {
  selection: Selection;
  /** The panel key of `selection` (stores/panel.ts keyOf). */
  panelKey: string;
}

/**
 * One kind of side-panel content. Add a surface by adding a file that exports a spec and
 * listing it in registry.ts; components look specs up by kind, never switch on it.
 */
export interface SurfaceSpec {
  kind: SurfaceKind;
  title: string;
  icon: LucideIcon;
  /** Single lowercase letter that opens the surface while the panel has focus. */
  hotkey: string;
  available: (ctx: SurfaceContext) => SurfaceAvailability;
  render: (tab: Tab) => ReactNode;
  /** The tab the empty state and the hotkey open; null when there is nothing to open. */
  openDefault: (ctx: SurfaceContext) => Tab | null;
}
