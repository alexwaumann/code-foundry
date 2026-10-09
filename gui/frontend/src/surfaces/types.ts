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

/** Anything with a Zustand-style subscribe: every `useXxxStore` qualifies. */
export interface Subscribable {
  subscribe: (listener: () => void) => () => void;
}

/**
 * One kind of side-panel content. Add a surface by adding a file that exports a spec and
 * listing it in registry.ts; components look specs up by kind, never switch on it.
 */
export interface SurfaceSpec {
  /** Unique across the registry; also the tab id prefix (stores/panel.ts tabId). */
  kind: SurfaceKind;
  title: string;
  icon: LucideIcon;
  /** Single lowercase letter that opens the surface while the panel has focus. */
  hotkey: string;
  /**
   * Availability right now. Pure and cheap: it runs during render (the empty list) and
   * in key and click handlers. It may read other stores with getState(), but every store
   * it reads must be listed in `watches`, or the empty list goes stale when they change.
   */
  available: (ctx: SurfaceContext) => SurfaceAvailability;
  /**
   * Stores `available` reads besides the selection (the panel already re-renders on a
   * selection change). useAvailability (registry.ts) subscribes to them and re-evaluates
   * `available` on every change; the row re-renders only when the answer changes.
   */
  watches?: readonly Subscribable[];
  /** The tab body. Mounted under key={tab.id}, so each tab gets fresh component state. */
  render: (tab: Tab) => ReactNode;
  /** The tab the empty state and the hotkey open; null when there is nothing to open. */
  openDefault: (ctx: SurfaceContext) => Tab | null;
}
