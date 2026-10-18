/**
 * Opening the Threads surface (surfaces/threads.ts). The view.panel.threads command
 * (threadsPanelCommand in stores/views.ts) ends here.
 */
import { selectionThread } from "@/surfaces/linkedprsTarget";
import { selectionThreadsThread, threadsTab } from "@/surfaces/threadsTarget";
import { keyOf, openSurface } from "./panel";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";

function stores() {
  return { projects: useProjectsStore.getState(), threads: useThreadsStore.getState() };
}

/** What the selection is for the surface: a thread with lineage (a creator, siblings or children), one without, or no thread. */
export function threadsPanelTarget(sel: Selection = useUiStore.getState().selection): "related" | "none" | "no-thread" {
  const s = stores();
  if (selectionThreadsThread(sel, s) !== null) return "related";
  return selectionThread(sel, s) !== null ? "none" : "no-thread";
}

/**
 * Opens (or activates) the Threads tab in the selection's panel when the selection is a
 * thread with lineage (the surface is enabled). Returns that panel's key, or null
 * otherwise. It does not request focus.
 */
export function openThreadsSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = keyOf(sel);
  if (key === null || selectionThreadsThread(sel, stores()) === null) return null;
  return openSurface(key, threadsTab()) ? key : null;
}
