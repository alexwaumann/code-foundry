/**
 * Opening the Usage surface (surfaces/usage.ts). The view.panel.usage command
 * (usagePanelCommand in stores/views.ts) ends here.
 */
import { selectionUsageThread, usageTab } from "@/surfaces/usageTarget";
import { keyOf, openSurface } from "./panel";
import { useReposStore } from "./repos";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";

/**
 * Opens (or activates) the Usage tab in the selection's panel when the selection is a
 * thread. Returns that panel's key, or null otherwise. It does
 * not request focus.
 */
export function openUsageSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = keyOf(sel);
  const s = { repos: useReposStore.getState(), threads: useThreadsStore.getState() };
  if (key === null || selectionUsageThread(sel, s) === null) return null;
  return openSurface(key, usageTab()) ? key : null;
}
