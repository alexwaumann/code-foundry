/**
 * thread.previous and thread.next (cmd+shift+[ / cmd+shift+]): the thread above or below
 * the current selection in sidebar order (docs/notes/thread-neighbours.md). Shared by the
 * window-local chord presenters (keys/bindings.ts) and the CLI's ShowView (stores/views.ts).
 */
import { sidebarAnchor } from "@/lib/inSidebar";
import { neighbourIn, threadOrder } from "@/lib/tree";
import { getListOptions, getListThreads } from "./context";
import { getShowCreatedThreads } from "./settings";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";

/**
 * Selects the thread `by` rows from the current one in sidebar order, wrapping; from a
 * page, next selects the first row and previous the last. A hidden thread selected starts
 * from its creator's row, as cmd+shift+a does. Rows of a collapsed section and hidden
 * threads do not count (cmd+1..9's order; Ember's row is not in it). The selection goes
 * through `select`, so it lands in the window's history. Returns whether one was selected.
 */
export function jumpToNeighbour(by: 1 | -1): boolean {
  const showCreated = getShowCreatedThreads();
  const sel = useUiStore.getState().selection;
  const order = threadOrder(getListThreads(showCreated), getListOptions());
  const from = sel.kind === "thread" ? sidebarAnchor(useThreadsStore.getState().byId, sel.id, showCreated) : null;
  const id = neighbourIn(order, from, by);
  if (id === null) return false;
  useUiStore.getState().select({ kind: "thread", id }, { focusPrompt: true });
  return true;
}
