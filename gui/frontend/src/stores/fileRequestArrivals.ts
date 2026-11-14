/**
 * A thread's request that the user edit a file (view.open.file --edit) arrives whole in its File
 * tab's params, written by the daemon in the same open_surface that places the tab: edit, the
 * asker, the request's id, the note, and focus=1 when the user asked to be taken there
 * (internal/command fileAskParams; docs/notes/shell-22-retire-verbs.md). The tab reads them like
 * any params (surfaces/fileTarget.ts fileOfTab), and Save and tell answers the asker
 * (stores/fileRequest.ts). A thread's call never moves the user's focus: the daemon keeps the new
 * tab behind the focused pane's active tab.
 *
 * This watcher does what only the window knows, once per request:
 * - with focus=1 the editor takes the keyboard at the end of the line, once it is on screen;
 * - without it, a request that landed in front of the editor the user is typing in, in that
 *   editor's own pane (the layout's focused pane can be another one), goes back behind it.
 *
 * A request already in the layout when the window first reads it is not new: a reload neither
 * takes the keyboard nor moves a tab.
 */
import { activateTab, groupOfTab, tabPlace } from "@/shell/host";
import { fileOfTab, fileTab } from "@/surfaces/fileTarget";
import { fileEditKey, focusEditorLine, typingIn } from "./fileEdit";
import { useLayoutStore, type LayoutState, type TabEntry } from "./layout";

/** A request that just arrived in `tab` (a File tab linked to its thread). */
function arrived(tab: TabEntry): void {
  const file = fileOfTab(tab);
  if (!file?.ask || !tab.thread) return;
  const key = `thread:${tab.thread}`;
  const id = fileTab(file).id;
  if (tab.params.focus === "1") {
    focusEditorLine(fileEditKey(key, id), file.line);
    return;
  }
  const editor = typingIn();
  if (!editor || editor.panelKey !== key || editor.tabId === id) return;
  const place = tabPlace(key);
  const g = groupOfTab(place, id);
  if (g === null || g !== groupOfTab(place, editor.tabId) || place.groups[g]?.active?.id !== id) return;
  activateTab(key, editor.tabId);
}

/** Starts watching the layout for new requests; returns the stop. */
export function startFileRequests(): () => void {
  // The request id each File tab had when last seen.
  const seen = new Map<string, string>();
  let primed = false;
  const scan = (s: LayoutState) => {
    if (!s.loaded) return;
    for (const id of seen.keys()) if (!(id in s.tabs)) seen.delete(id);
    for (const tab of Object.values(s.tabs)) {
      const ask = tab.params.askId;
      if (!ask || seen.get(tab.id) === ask) continue;
      seen.set(tab.id, ask);
      if (primed) arrived(tab);
    }
    primed = true;
  };
  scan(useLayoutStore.getState());
  return useLayoutStore.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs || s.loaded !== prev.loaded) scan(s);
  });
}
