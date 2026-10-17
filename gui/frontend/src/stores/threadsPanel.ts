/**
 * Opening the Threads surface (surfaces/threads.ts). The view.panel.threads command
 * (threadsPanelCommand in stores/views.ts) ends here.
 */
import { selectionThreadsThread, threadsTab } from "@/surfaces/threadsTarget";
import { keyOf, openSurface } from "./panel";
import { useReposStore } from "./repos";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";

/**
 * Opens (or activates) the Threads tab in the selection's panel when the selection is a
 * thread. Returns that panel's key, or null otherwise. It does not request focus.
 */
export function openThreadsSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = keyOf(sel);
  const s = { repos: useReposStore.getState(), threads: useThreadsStore.getState() };
  if (key === null || selectionThreadsThread(sel, s) === null) return null;
  return openSurface(key, threadsTab()) ? key : null;
}
