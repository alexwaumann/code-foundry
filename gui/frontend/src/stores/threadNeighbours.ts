/**
 * thread.previous and thread.next (cmd+shift+[ / cmd+shift+]): the thread above or below
 * the current selection in sidebar order (docs/notes/thread-neighbours.md). Shared by the
 * window-local chord presenters (keys/bindings.ts) and the CLI's ShowView (stores/views.ts).
 */
import { sidebarAnchor } from "@/lib/inSidebar";
import { neighbourIn } from "@/lib/tree";
import { sidebarThreadOrder } from "./shellList";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";

/**
 * Selects the thread `by` rows from the current one in sidebar order, wrapping; from a
 * page, next selects the first row and previous the last. A hidden thread selected starts
 * from its creator's row, as cmd+shift+a does. Only rows on screen count: those of a
 * collapsed section and hidden threads do not, the open thread's row under a collapsed
 * header does (cmd+1..9's order; Ember's row is not in it). The selection goes
 * through `select`, so it lands in the window's history. Returns whether one was selected.
 */
export function jumpToNeighbour(by: 1 | -1): boolean {
  const sel = useUiStore.getState().selection;
  const order = sidebarThreadOrder();
  const from = sel.kind === "thread" ? sidebarAnchor(useThreadsStore.getState().byId, sel.id) : null;
  const id = neighbourIn(order, from, by);
  if (id === null) return false;
  useUiStore.getState().select({ kind: "thread", id }, { focusPrompt: true });
  return true;
}
