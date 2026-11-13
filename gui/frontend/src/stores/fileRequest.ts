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
 * close dialog's Save do. Row two's Save writes and leaves the request up. "Saved" must be
 * true: with no write since the request and nothing to write, there is nothing to tell, and
 * cmd+S does nothing, as anywhere.
 */
import { versionStamp } from "@/api/files";
import { errorMessage } from "@/api/stream";
import { fileName, relativeTo } from "@/lib/filePath";
import { tildify } from "@/lib/path";
import { plainLine, plainName, plainPath } from "@/lib/plainText";
import { ASK_PARAMS, fileOfTab, withoutParams, type FileAsk } from "@/surfaces/fileTarget";
import { requestChoice } from "./confirm";
import { discardEdit, fileEditKey, fileEditOf, focusEditor, focusedEdit, noteEditFailure, returnFromPalette, saveFile, type FileEdit, type FileWhere, type SaveOutcome } from "./fileEdit";
import { activateTab, findTab, setTabParams, type Tab } from "@/shell/host";
import { deliverThreadPrompt } from "./threadInfo";
import { useThreadsStore } from "./threads";

function tabOf(s: FileEdit): Tab | undefined {
  return findTab(s.panelKey, s.tabId);
}

/** The request standing on a session's tab; null without one. */
function askOf(s: FileEdit | undefined): FileAsk | null {
  const tab = s && tabOf(s);
  return (tab && fileOfTab(tab)?.ask) ?? null;
}

/**
 * Whether Save and tell can run now: something to write, or what is on disk being a write of
 * ours since the request (row two's Save, Overwrite), which only needs telling. The version
 * is compared, so a document that started over on anyone else's, a file that went and one
 * that came back all count for nothing. A conflict is settled first.
 */
export function canTell(s: FileEdit, ask: FileAsk): boolean {
  if (s.view === null || s.busy || s.conflict !== null) return false;
  return s.dirty || (!s.creating && ask.saved === versionStamp(s.view));
}

/** What the thread is told: the path as the user sees it, nothing from the file, and not to go and read it. */
export function savedMessage(path: string, project: string, base: string): string {
  return `I saved ${(project ? relativeTo(path, base) : null) ?? tildify(path)}. Continue without reading its values.`;
}

/** Who asked, as a sentence's subject. The name is model-settable, so it is quoted and cleaned. */
export function askerLabel(name: string | undefined, unnamed = "A thread"): string {
  const shown = plainName(name ?? "");
  return shown ? `Thread "${shown}"` : unnamed;
}

/**
 * What the user should know about where this file really is, as facts: where a save lands
 * when a link leads elsewhere, and who else can read it. Neither is a refusal. A link's target
 * is anyone's text: it is cleaned and cut like a note, and said to be if cleaning changed it.
 */
export function fileFacts(file: FileWhere): string[] {
  const facts: string[] = [];
  if (file.realPath && file.realPath !== file.path) {
    const real = tildify(file.realPath);
    facts.push(`This path is a link: the file is really ${plainPath(real)}${plainLine(real) === real ? "" : " (its name has characters not shown here)"}.`);
  }
  const group = (file.mode & 0o040) !== 0;
  const others = (file.mode & 0o004) !== 0;
  if (group || others) facts.push(`${group && others ? "Group and others" : group ? "Group" : "Others"} can read this file (${file.mode.toString(8).padStart(4, "0")}).`);
  return facts;
}

/**
 * The request is over, unless a newer one took its place while a write was out. Decided on the
 * tab's newest params, those of an update still on its way included (the seam's queue): a newer
 * request sent but not yet landed stands.
 */
function finish(s: FileEdit, ask: FileAsk): void {
  if (askOf(s)?.id !== ask.id) return;
  const end = withoutParams(ASK_PARAMS);
  setTabParams(s.panelKey, s.tabId, (now) => (now.askId === ask.id ? end(now) : now));
}

/** "saved" and told; "untold" when the write stood and the thread did not hear; otherwise the write's outcome and nothing was sent. */
export type TellOutcome = SaveOutcome | "untold";

/** Writes the draft, then tells the thread. The request ends before the send, so nothing can send twice. */
export async function saveAndTell(key: string): Promise<TellOutcome> {
  const s = fileEditOf(key);
  const ask = askOf(s);
  if (!s || !ask || !canTell(s, ask)) return "skipped";
  const project = tabOf(s)?.params.project ?? "";
  const written = s.dirty ? await saveFile(key) : "saved";
  if (written !== "saved") return written;
  finish(s, ask);
  const why = await tell(ask.thread, savedMessage(s.path, project, s.base));
  if (why === null) return "saved";
  noteEditFailure(key, `Saved, but ${askerLabel(useThreadsStore.getState().byId[ask.thread]?.name, "the thread")} was not told: ${plainName(why, MAX_WHY)}`);
  return "untold";
}

/** The most of a failure the band says: a removed thread's answer holds its name. */
const MAX_WHY = 200;

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
 * Discard throws the edits away now: a closed tab's dirty session would otherwise wait for the
 * file to come back (stores/fileEdit.ts prune).
 */
export function confirmCloseFile(panelKey: string, tab: Tab): true | Promise<boolean> {
  const key = fileEditKey(panelKey, tab.id);
  const s = fileEditOf(key);
  if (!s?.dirty) return true;
  return askEnd(key, s, { title: tab.title, message: "Unsaved edits are lost if you discard them." });
}

/**
 * Asked before something the user does ends dirty edit sessions for good (archiving their
 * thread, removing its space with its threads archived), one file at a time: Save, Discard or
 * Keep editing. Resolves true when every one was saved or discarded; false at the first Keep
 * editing or failed save, and then nothing is to happen. `why` says what ends them.
 */
export async function confirmEndEdits(keys: readonly string[], why: string): Promise<boolean> {
  for (const key of keys) {
    const s = fileEditOf(key);
    if (!s?.dirty) continue;
    if (!(await askEnd(key, s, { title: "", message: `${why} Unsaved edits are lost if you discard them.` }))) return false;
  }
  return true;
}

/** The Save, Discard, Keep editing question about one session; true once it may end. */
async function askEnd(key: string, s: FileEdit, opts: { title: string; message: string }): Promise<boolean> {
  const answer = await requestChoice({
    title: `Save changes to ${fileName(s.view?.path ?? s.path) || opts.title}?`,
    message: opts.message,
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
  if (answer === "alternate") {
    discardEdit(key);
    return true;
  }
  if ((await saveTab(key)) === "saved") return true;
  // Shown where it is, with why (a tab put away says so when its file is opened again).
  activateTab(s.panelKey, s.tabId);
  return false;
}
