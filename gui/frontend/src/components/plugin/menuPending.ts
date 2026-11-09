import type { ViewMenuItem } from "@/api/plugin";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useViewCtx } from "./context";
import { menuKeys } from "./menu";

/**
 * Whether one of a menu's items has an act in flight: its trigger (the ⋯, a menu button)
 * spins meanwhile, since the menu itself has closed.
 */
export function useMenuPending(items: readonly ViewMenuItem[] | undefined): boolean {
  const { watchKey } = useViewCtx();
  return usePluginSurfacesStore((s) => {
    const p = s.pending[watchKey];
    return p !== undefined && items !== undefined && menuKeys(items).some((k) => p[k] === true);
  });
}
