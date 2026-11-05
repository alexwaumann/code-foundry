/**
 * Editing a file in the File tab (docs/notes/file-edit-2-gui.md): one session per tab per
 * panel, so two panels showing a file never share a draft.
 *
 * Memory only, by design: file contents are often secrets, so unsaved edits are lost on
 * quit. This store is never persisted, the panel state never holds a draft, and nothing
 * here is logged. The edited text itself is the library's (lib/codeEditor.ts); the session
 * knows the version it was read from and whether the two differ.
 *
 * The rule the tab's reads go through (observeRead): while a session has a document, no
 * read reaches the editor on its own, because a new `file` prop replaces the document
 * and so the draft. A dirty session compares the read's size and time with its baseline
 * and raises a conflict instead; a clean one starts over on the new version.
 */
import { create } from "zustand";
import { canEdit, readFile, writeFile, type FileReadView } from "@/api/files";
import { errorMessage } from "@/api/stream";
import { draftText, forgetDraft, loadCodeEditor } from "@/lib/codeEditor";
import { fileName } from "@/lib/filePath";
import { requestChoice } from "./confirm";
import { activatePanelTab, activeTab, allTabs, getPanel, keyOf, usePanelStore, type PanelEntry, type Tab } from "./panel";
import { useUiStore } from "./ui";

/** What is wrong with the draft's baseline: the file was changed, or is gone. */
export type EditConflict = "changed" | "deleted";

export interface FileEdit {
  panelKey: string;
  tabId: string;
  /** The tab's checkout, as for readFile. */
  base: string;
  /** The version being edited, its text the baseline of `dirty`. Null when a clean session left the screen: the tab's next read starts it again. */
  view: FileReadView | null;
  /** What the editor's document started from. It stays put after a save: a new `file` prop would reset the document. */
  seed: string;
  /** The library's key for this document's draft. */
  stateKey: string;
  /** Goes up when the document starts over (Discard, Reload, a clean re-read), which remounts the editor. */
  revision: number;
  dirty: boolean;
  conflict: EditConflict | null;
  /** Why the last save failed, in the daemon's words. */
  failure: string | null;
  saving: boolean;
  /** A read that started before this moment says nothing about the baseline (editClock). */
  readsFrom: number;
}

interface FileEditState {
  sessions: Readonly<Record<string, FileEdit>>;
}

export const useFileEditStore = create<FileEditState>()(() => ({ sessions: {} }));

/** A tab's session key. */
export function fileEditKey(panelKey: string, tabId: string): string {
  return `${panelKey}\u0000${tabId}`;
}

/** The tab's session, for its body (a session changes when its state does, not per keystroke). */
export function useFileEdit(key: string): FileEdit | undefined {
  return useFileEditStore((s) => s.sessions[key]);
}

/** Whether the tab has unsaved edits. */
export function useFileDirty(key: string): boolean {
  return useFileEditStore((s) => s.sessions[key]?.dirty === true);
}

function session(key: string): FileEdit | undefined {
  return useFileEditStore.getState().sessions[key];
}

function patch(key: string, change: Partial<FileEdit>): void {
  useFileEditStore.setState((s) => {
    const was = s.sessions[key];
    return was ? { sessions: { ...s.sessions, [key]: { ...was, ...change } } } : s;
  });
}

let stateKeys = 0;

function nextStateKey(key: string): string {
  stateKeys += 1;
  return `${key}\u0000${String(stateKeys)}`;
}

/** Ends a session and drops its draft (an editor still on screen drops it in editorDetached). */
function end(key: string): void {
  const was = session(key);
  if (!was) return;
  useFileEditStore.setState((s) => {
    const { [key]: _gone, ...rest } = s.sessions;
    return { sessions: rest };
  });
  forgetDraft(was.stateKey);
}

// A tab can go without closeTab (its panel dropped with its thread): whatever removes it,
// its draft goes with it.
function prune(byKey: Readonly<Record<string, PanelEntry>>): void {
  for (const [key, s] of Object.entries(useFileEditStore.getState().sessions)) {
    const entry = byKey[s.panelKey];
    if (s.panelKey !== "" && !(entry && allTabs(entry).some((t) => t.id === s.tabId))) end(key);
  }
}

usePanelStore.subscribe((s) => {
  prune(s.byKey);
});

// Reads and writes race: a read that left before a save and answers after it reports the
// old version, which must not look like someone else's change. Each read is stamped with
// the clock when it left, and a write moves the clock.
let clock = 0;
const readStarts = new WeakMap<FileReadView, number>();

/** The moment a read starts, for noteRead. */
export function editClock(): number {
  return clock;
}

/** Records when a read left. */
export function noteRead(view: FileReadView, started: number): void {
  readStarts.set(view, started);
}

function sameVersion(a: FileReadView, b: FileReadView): boolean {
  return a.size === b.size && a.modifiedAtMs === b.modifiedAtMs;
}

/** The session starts over on `view`: a new document, nothing to save, nothing wrong. */
function adopt(key: string, was: FileEdit, view: FileReadView): void {
  clock += 1;
  forgetDraft(was.stateKey);
  patch(key, { view, seed: view.text ?? "", stateKey: nextStateKey(key), revision: was.revision + 1, dirty: false, conflict: null, failure: null, readsFrom: clock });
}

/**
 * Turns the editor on for a tab. Loads it first, so the tab flips once it can. A session
 * already there stays: a second click must not reset a draft.
 */
export async function startEdit(key: string, target: { panelKey: string; tabId: string; base: string }, view: FileReadView): Promise<void> {
  await loadCodeEditor();
  if (session(key) || !canEdit(view)) return;
  useFileEditStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [key]: { ...target, view, seed: view.text ?? "", stateKey: nextStateKey(key), revision: 0, dirty: false, conflict: null, failure: null, saving: false, readsFrom: clock },
    },
  }));
}

/** Back to the viewer. Only a clean document leaves: a dirty one keeps its draft, whatever asked. */
export function stopEdit(key: string): void {
  if (session(key)?.dirty === false) end(key);
}

/** The editor's document changed. */
export function noteDraft(key: string, text: string): void {
  const s = session(key);
  if (!s?.view) return;
  const dirty = text !== s.view.text;
  if (dirty !== s.dirty || s.failure !== null) patch(key, { dirty, failure: null });
}

/**
 * What the tab just read, whichever trigger read it (mount, Refresh, the window coming back,
 * a worktree event, the thread's own edit, the file's stamp). Nothing here feeds a dirty
 * document: at most it raises the conflict band. A clean one follows the file, and leaves
 * edit mode if the file is no longer one it can edit.
 */
export function observeRead(key: string, view: FileReadView): void {
  const s = session(key);
  if (!s || s.saving || (readStarts.get(view) ?? Infinity) < s.readsFrom) return;
  if (!s.view) {
    if (canEdit(view)) adopt(key, s, view);
    else end(key);
    return;
  }
  const same = !view.notFound && sameVersion(s.view, view);
  if (s.dirty) {
    const conflict = same ? null : view.notFound ? "deleted" : "changed";
    if (conflict !== s.conflict) patch(key, { conflict });
  } else if (!same) {
    if (canEdit(view)) adopt(key, s, view);
    else end(key);
  }
}

export type SaveOutcome = "saved" | "conflict" | "failed" | "skipped";

/**
 * Writes the draft (Save, cmd+S, the close dialog; `force` is Overwrite). Works whether or
 * not the tab is on screen: the draft is the library's. The returned size and time become
 * the baseline, so the read that follows sees nothing new. Whatever goes wrong, the draft
 * stays. The tab keeps editing.
 */
export async function saveFile(key: string, opts: { force?: boolean } = {}): Promise<SaveOutcome> {
  const s = session(key);
  if (!s?.view || s.saving || !(s.dirty || opts.force === true)) return "skipped";
  const text = draftText(s.stateKey);
  if (text === null) return "skipped";
  const { view } = s;
  clock += 1;
  patch(key, { saving: true, failure: null, readsFrom: clock });
  try {
    const r = await writeFile(s.base, view.path, text, view, opts);
    clock += 1;
    if (r.conflict) {
      patch(key, { saving: false, conflict: r.notFound ? "deleted" : "changed", readsFrom: clock });
      return "conflict";
    }
    const saved = { ...view, text, size: r.size, modifiedAtMs: r.modifiedAtMs, notFound: false };
    // Edits typed while the write ran are still unsaved.
    const now = session(key);
    patch(key, { view: saved, dirty: now !== undefined && draftText(now.stateKey) !== text, conflict: null, saving: false, readsFrom: clock });
    return "saved";
  } catch (err) {
    patch(key, { saving: false, failure: errorMessage(err) });
    return "failed";
  }
}

/** The document goes back to the version on disk now (Reload; Discard during a conflict). Leaves edit mode when that is not one it can edit. */
export async function reloadDraft(key: string): Promise<void> {
  const s = session(key);
  if (!s?.view) return;
  try {
    const fresh = await readFile(s.base, s.view.path);
    const now = session(key);
    if (!now) return;
    if (canEdit(fresh)) adopt(key, now, fresh);
    else end(key);
  } catch (err) {
    patch(key, { failure: errorMessage(err) });
  }
}

/** Discard: the draft goes. Against a file that moved on, that means what is on disk now. */
export async function discardDraft(key: string): Promise<void> {
  const s = session(key);
  if (!s?.view || !s.dirty) return;
  if (s.conflict) await reloadDraft(key);
  else adopt(key, s, s.view);
}

/**
 * The tab's editor went: its tab left the screen, or its document started over. A dirty
 * draft waits in the library for the tab to come back; anything else is contents with no
 * reason to stay. A clean session keeps edit mode without them, and reads when it returns.
 */
export function editorDetached(key: string, stateKey: string): void {
  const s = session(key);
  if (s?.stateKey !== stateKey) {
    forgetDraft(stateKey);
    return;
  }
  if (s.dirty) return;
  forgetDraft(stateKey);
  patch(key, { view: null, seed: "", stateKey: nextStateKey(key) });
}

/**
 * Asked before a File tab closes (SurfaceSpec.beforeClose): a dirty one asks Save, Discard
 * or Keep editing. A save that does not go through keeps the tab, on screen, showing why.
 */
export function confirmCloseFile(panelKey: string, tab: Tab): true | Promise<boolean> {
  const key = fileEditKey(panelKey, tab.id);
  const s = session(key);
  if (!s?.dirty) return true;
  return askClose(key, panelKey, tab, fileName(s.view?.path ?? "") || tab.title);
}

async function askClose(key: string, panelKey: string, tab: Tab, name: string): Promise<boolean> {
  const answer = await requestChoice({
    title: `Save changes to ${name}?`,
    message: "Unsaved edits are lost if you discard them.",
    confirmLabel: "Save",
    alternateLabel: "Discard",
    cancelLabel: "Keep editing",
    centered: true,
  });
  if (answer === "cancel") return false;
  if (answer === "alternate") return true;
  if ((await saveFile(key)) === "saved") return true;
  activatePanelTab(panelKey, tab.id);
  return false;
}

/** The session of the tab in front: the focused group's active tab of the window's panel. */
function focusedEdit(): string | null {
  const panelKey = keyOf(useUiStore.getState().selection);
  if (panelKey === null) return null;
  const tab = activeTab(getPanel(panelKey));
  const key = tab ? fileEditKey(panelKey, tab.id) : null;
  return key !== null && session(key)?.view ? key : null;
}

/** Whether file.save would do anything here: the palette lists it only then. */
export function canSaveFile(): boolean {
  return focusedEdit() !== null;
}

/** file.save in this window: saves the focused File tab. With nothing editing, nothing happens; the command is still handled. */
export function presentFileSave(): boolean {
  const key = focusedEdit();
  if (key !== null) void saveFile(key);
  return true;
}
