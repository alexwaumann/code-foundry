/**
 * A thread's request that the user edit a file (view.panel.file --edit,
 * docs/notes/file-edit-3-agent.md). The request lives in the File tab's params, so it waits
 * for a tab that is not on screen and survives a reload; dropping them finishes it for good.
 *
 * What the thread hears is one ordinary message through thread.send, the composer's path,
 * saying the file was saved: it carries the path as the user sees it and nothing from the
 * file. The message goes after a write that stood, never before and never after one that
 * failed or conflicted; a send that fails leaves the save standing and says so.
 *
 * While a tab has a request, Save and tell is what cmd+S, the palette's Save File and the
 * close dialog's Save do. Row two's Save writes and leaves the request up.
 */
import { errorMessage } from "@/api/stream";
import { fileName, relativeTo } from "@/lib/filePath";
import { tildify } from "@/lib/path";
import { ASK_PARAMS, fileOfTab, type FileAsk } from "@/surfaces/fileTarget";
import { requestChoice } from "./confirm";
import { fileEditKey, fileEditOf, focusEditor, focusedEdit, noteEditFailure, returnFromPalette, saveFile, type FileEdit, type SaveOutcome } from "./fileEdit";
import { activatePanelTab, allTabs, dropPanelTabParams, getPanel, type Tab } from "./panel";
import { deliverThreadPrompt } from "./threadInfo";
import { useThreadsStore } from "./threads";

function tabOf(s: FileEdit): Tab | undefined {
  return allTabs(getPanel(s.panelKey)).find((t) => t.id === s.tabId);
}

/** The request standing on a session's tab; null without one. */
function askOf(s: FileEdit | undefined): FileAsk | null {
  const tab = s && tabOf(s);
  return (tab && fileOfTab(tab)?.ask) ?? null;
}

/**
 * Whether Save and tell can run now. A clean document with a file behind it has nothing to
 * write and only tells: the user saved with row two's Save, or it needed nothing. One with
 * no file yet has nothing to say, and a conflict is settled first.
 */
export function canTell(s: FileEdit): boolean {
  return s.view !== null && !s.busy && s.conflict === null && (s.dirty || !s.creating);
}

/** What the thread is told: the path as the user sees it and nothing else. */
export function savedMessage(path: string, project: string, base: string): string {
  return `I saved ${(project ? relativeTo(path, base) : null) ?? tildify(path)}.`;
}

/** The request is over, unless a newer one took its place while a write was out. */
function finish(s: FileEdit, ask: FileAsk): void {
  const now = askOf(s);
  if (now?.thread === ask.thread && now.note === ask.note) dropPanelTabParams(s.panelKey, s.tabId, ASK_PARAMS);
}

/** "saved" and told; "untold" when the write stood and the thread did not hear; otherwise the write's outcome and nothing was sent. */
export type TellOutcome = SaveOutcome | "untold";

/** Writes the draft, then tells the thread. The request ends before the send, so nothing can send twice. */
export async function saveAndTell(key: string): Promise<TellOutcome> {
  const s = fileEditOf(key);
  const ask = askOf(s);
  if (!s || !ask || !canTell(s)) return "skipped";
  const project = tabOf(s)?.params.project ?? "";
  const written = s.dirty ? await saveFile(key) : "saved";
  if (written !== "saved") return written;
  finish(s, ask);
  const why = await tell(ask.thread, savedMessage(s.path, project, s.base));
  if (why === null) return "saved";
  const name = useThreadsStore.getState().byId[ask.thread]?.name;
  noteEditFailure(key, `Saved, but ${name || "the thread"} was not told: ${why}`);
  return "untold";
}

/** Sends the message: null when it went, else why not. */
async function tell(thread: string, text: string): Promise<string | null> {
  try {
    return (await deliverThreadPrompt(thread, text)) ? null : "the send was declined.";
  } catch (err) {
    return errorMessage(err);
  }
}

/** Dismiss: the request is over and nothing is sent. Editing goes on. */
export function dismissAsk(key: string): void {
  const s = fileEditOf(key);
  const ask = askOf(s);
  if (s && ask) finish(s, ask);
}

/** What saving means for this tab: with a request standing, Save and tell. */
function saveTab(key: string): Promise<TellOutcome> {
  return askOf(fileEditOf(key)) ? saveAndTell(key) : saveFile(key);
}

/** file.save in this window. With nothing to save, nothing happens; the command is still handled. */
export function presentFileSave(): boolean {
  const key = focusedEdit();
  if (key === null) return true;
  void saveTab(key);
  returnFromPalette(key);
  return true;
}

/**
 * Asked before a File tab closes (SurfaceSpec.beforeClose): a dirty one asks Save, Discard
 * or Keep editing. A save that does not go through keeps the tab, on screen, showing why.
 */
export function confirmCloseFile(panelKey: string, tab: Tab): true | Promise<boolean> {
  const key = fileEditKey(panelKey, tab.id);
  const s = fileEditOf(key);
  if (!s?.dirty) return true;
  return askClose(key, panelKey, tab, s);
}

async function askClose(key: string, panelKey: string, tab: Tab, s: FileEdit): Promise<boolean> {
  const answer = await requestChoice({
    title: `Save changes to ${fileName(s.view?.path ?? "") || tab.title}?`,
    message: "Unsaved edits are lost if you discard them.",
    confirmLabel: askOf(s) ? "Save and tell thread" : "Save",
    alternateLabel: "Discard",
    cancelLabel: "Keep editing",
    centered: true,
  });
  if (answer === "cancel") {
    // After the dialog hands focus back, which it cannot do into a shadow root.
    requestAnimationFrame(() => {
      focusEditor(key);
    });
    return false;
  }
  if (answer === "alternate") return true;
  if ((await saveTab(key)) === "saved") return true;
  activatePanelTab(panelKey, tab.id);
  return false;
}
