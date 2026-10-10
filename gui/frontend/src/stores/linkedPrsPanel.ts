/**
 * Opening the Linked PRs surface (surfaces/linkedprs.ts). The view.panel.linked-prs
 * command (linkedPrsPanelCommand in stores/views.ts), the session header button (the
 * command) and the sidebar's PR badge end here.
 */
import { linkedPrsTab, selectionLinkedThread, selectionThread } from "@/surfaces/linkedprsTarget";
import { keyOf, openSurface } from "./panel";
import { useReposStore } from "./repos";
import { useSessionsStore } from "./sessions";
import { useTerminalsStore } from "./terminals";
import { useUiStore, type Selection } from "./ui";

function stores() {
  return { repos: useReposStore.getState(), sessions: useSessionsStore.getState(), terminals: useTerminalsStore.getState() };
}

/** What the selection is for the surface: a thread with links, a thread without any, or no thread. */
export function linkedPrsTarget(sel: Selection = useUiStore.getState().selection): "linked" | "none" | "no-thread" {
  const s = stores();
  if (selectionLinkedThread(sel, s) !== null) return "linked";
  return selectionThread(sel, s) !== null ? "none" : "no-thread";
}

/**
 * Opens (or activates) the Linked PRs tab in the selection's panel when the selection is
 * a thread (or a thread's terminal) with linked pull requests. Returns that panel's key,
 * or null otherwise. It does not request focus.
 */
export function openLinkedPrsSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = keyOf(sel);
  if (key === null || selectionLinkedThread(sel, stores()) === null) return null;
  return openSurface(key, linkedPrsTab()) ? key : null;
}
