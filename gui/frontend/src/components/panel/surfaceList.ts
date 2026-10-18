import { useUiStore } from "@/stores/ui";
import type { SurfaceContext } from "@/surfaces/registry";

/** A panel's surface context, read now. */
export function surfaceContext(panelKey: string): SurfaceContext {
  return { selection: useUiStore.getState().selection, panelKey };
}

/**
 * The surface list unmounts when a tab opens or picking ends. Focus that was in it (a
 * row reached with Tab) moves to the panel first, so cmd+w and the letters keep working,
 * as in LinkedPRsSurface's openLink.
 */
export function keepPanelFocus(from: Element): void {
  const list = from.closest("[data-surface-list]");
  if (list?.contains(document.activeElement)) list.closest<HTMLElement>('[data-region="panel"]')?.focus({ preventScroll: true });
}
