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
import { draftText, forgetDraft, loadCodeEditor, type EditorHandle, type EditorPlace } from "@/lib/codeEditor";
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
  /** The resolved path it started on, for good: every read and write of the session is of this file. */
  path: string;
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
  /** What went wrong last, as a sentence: a save or a reload, in the daemon's words. */
  failure: string | null;
  /** A write or a reload is out: nothing else may touch the document or the baseline until it answers. */
  busy: boolean;
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

/** The library's key for a new document; also on the editor's DOM (CodeFile), so focus can tell whose it is. */
function nextStateKey(): string {
  stateKeys += 1;
  return `draft-${String(stateKeys)}`;
}

// The editors on screen, and where the keyboard goes when a tab's next one attaches.
const editors = new Map<string, EditorHandle>();
const nextFocus = new Map<string, EditorPlace | null>();

/** The tab's editor is on screen. It takes the keyboard if it was asked to. */
export function noteEditor(key: string, editor: EditorHandle): void {
  editors.set(key, editor);
  const at = nextFocus.get(key);
  if (at === undefined) return;
  nextFocus.delete(key);
  editor.focus(at ?? undefined);
}

/** Puts the keyboard back in the tab's editor, if it is on screen. */
export function focusEditor(key: string): void {
  editors.get(key)?.focus();
}

/** The next editor of this tab takes the keyboard (the pencil, Discard, Reload). */
export function focusNextEditor(key: string): void {
  nextFocus.set(key, null);
}

/** The session whose editor has the keyboard (its find field too); null when none does. */
function editorWithFocus(): string | null {
  const stateKey = document.activeElement?.closest("[data-code-editor]")?.getAttribute("data-code-editor");
  if (!stateKey) return null;
  const found = Object.entries(useFileEditStore.getState().sessions).find(([, s]) => s.stateKey === stateKey);
  return found ? found[0] : null;
}

/** Ends a session and drops its draft (an editor still on screen drops it in editorDetached). */
function end(key: string): void {
  const was = session(key);
  if (!was) return;
  editors.delete(key);
  nextFocus.delete(key);
  useFileEditStore.setState((s) => {
    const { [key]: _gone, ...rest } = s.sessions;
    return { sessions: rest };
  });
  forgetDraft(was.stateKey);
}

// A tab can go without closeTab: whatever removes it, its draft goes with it. Putting a
// thread away is not one of those: resetThreadPanels keeps dirty tabs (unsavedTabs).
function prune(byKey: Readonly<Record<string, PanelEntry>>): void {
  for (const [key, s] of Object.entries(useFileEditStore.getState().sessions)) {
    const entry = byKey[s.panelKey];
    if (s.panelKey !== "" && !(entry && allTabs(entry).some((t) => t.id === s.tabId))) end(key);
  }
}

usePanelStore.subscribe((s) => {
  prune(s.byKey);
});

/** The panel's tabs holding unsaved edits, which must survive a reset of the panel. */
export function unsavedTabs(panelKey: string, entry: PanelEntry): readonly Tab[] {
  return allTabs(entry).filter((t) => session(fileEditKey(panelKey, t.id))?.dirty === true);
}

/** The panel's thread was removed: nothing can reach its drafts again. Removing is the user's explicit word, so they go. */
export function dropPanelDrafts(panelKey: string): void {
  for (const [key, s] of Object.entries(useFileEditStore.getState().sessions)) {
    if (s.panelKey === panelKey) end(key);
  }
}

// Reads and writes race: a read that left before a save and answers after it reports the
// old version, which must not look like someone else's change. Each read is stamped with
// the clock when it left, and a write moves the clock.
let clock = 0;
const readStarts = new WeakMap<FileReadView, number>();

/** The file a tab's reads must be of while it has a session; null without one. */
export function editPath(key: string): string | null {
  return session(key)?.path ?? null;
}

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
  patch(key, { view, seed: view.text ?? "", stateKey: nextStateKey(), revision: was.revision + 1, dirty: false, conflict: null, failure: null, busy: false, readsFrom: clock });
}

/** A clean document follows the file. The new editor keeps the keyboard and the caret, if the old one had them. */
function follow(key: string, was: FileEdit, view: FileReadView): void {
  if (editorWithFocus() === key) nextFocus.set(key, editors.get(key)?.caret() ?? null);
  adopt(key, was, view);
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
      [key]: { ...target, path: view.path, view, seed: view.text ?? "", stateKey: nextStateKey(), revision: 0, dirty: false, conflict: null, failure: null, busy: false, readsFrom: clock },
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
 * document: at most it raises the conflict band. A file that went says so, clean or dirty.
 * A clean document follows the file, and leaves edit mode if the file is no longer one it can
 * edit. A read of any other file is no news about this one (one that left before the session).
 */
export function observeRead(key: string, view: FileReadView): void {
  const s = session(key);
  if (!s || s.busy || view.path !== s.path || (readStarts.get(view) ?? Infinity) < s.readsFrom) return;
  if (!s.view) {
    if (canEdit(view)) adopt(key, s, view);
    else end(key);
  } else if (view.notFound) {
    if (s.conflict !== "deleted") patch(key, { conflict: "deleted" });
  } else if (sameVersion(s.view, view)) {
    if (s.conflict !== null) patch(key, { conflict: null });
  } else if (s.dirty) {
    if (s.conflict !== "changed") patch(key, { conflict: "changed" });
  } else if (canEdit(view)) follow(key, s, view);
  else end(key);
}

export type SaveOutcome = "saved" | "conflict" | "failed" | "skipped";

/** The library keeps so many dormant drafts (EditStateManager's LRU) that the oldest went. */
const DRAFT_LOST = "The unsaved edits here are gone: only the 100 most recent tabs' drafts are kept.";

/**
 * Writes the draft (Save, cmd+S, the close dialog; `force` is Overwrite) to the session's
 * file. Works whether or not the tab is on screen: the draft is the library's. The returned
 * size and time become the baseline, so the read that follows sees nothing new. Whatever goes
 * wrong, the draft stays. The tab keeps editing.
 */
export async function saveFile(key: string, opts: { force?: boolean } = {}): Promise<SaveOutcome> {
  const s = session(key);
  if (!s?.view || s.busy || !(s.dirty || opts.force === true)) return "skipped";
  const text = draftText(s.stateKey);
  if (text === null) {
    patch(key, { failure: DRAFT_LOST });
    return "failed";
  }
  const { view } = s;
  clock += 1;
  patch(key, { busy: true, failure: null, readsFrom: clock });
  // The answer is about this document: the session may have let it go meanwhile (a clean tab left the screen).
  const current = () => {
    const now = session(key);
    return now?.stateKey === s.stateKey ? now : null;
  };
  try {
    const r = await writeFile(s.base, s.path, text, view, opts);
    clock += 1;
    const now = current();
    if (!now) {
      patch(key, { busy: false, readsFrom: clock });
      return r.conflict ? "conflict" : "saved";
    }
    if (r.conflict) {
      patch(key, { busy: false, conflict: r.notFound ? "deleted" : "changed", readsFrom: clock });
      return "conflict";
    }
    const saved = { ...view, text, size: r.size, modifiedAtMs: r.modifiedAtMs, notFound: false };
    // Edits typed while the write ran are still unsaved.
    patch(key, { view: saved, dirty: draftText(now.stateKey) !== text, conflict: null, busy: false, readsFrom: clock });
    return "saved";
  } catch (err) {
    patch(key, current() ? { busy: false, failure: `Could not save: ${errorMessage(err)}` } : { busy: false });
    return "failed";
  }
}

/**
 * Reads the file again and starts the document over on it. When that cannot be (it went, or
 * it is no longer one to edit), `giveUp` says what happens to the draft.
 */
async function readBack(key: string, giveUp: (s: FileEdit, fresh: FileReadView) => void): Promise<void> {
  const s = session(key);
  if (!s?.view || s.busy) return;
  patch(key, { busy: true });
  try {
    const fresh = await readFile(s.base, s.path);
    const now = session(key);
    if (now?.stateKey !== s.stateKey) patch(key, { busy: false });
    else if (canEdit(fresh)) adopt(key, now, fresh);
    else giveUp(now, fresh);
  } catch (err) {
    nextFocus.delete(key);
    patch(key, { busy: false, failure: `Could not reload: ${errorMessage(err)}` });
    focusEditor(key);
  }
}

/** Reload: the document goes to what is on disk. If there is nothing to take, the draft stays and the tab says why. */
export function reloadDraft(key: string): Promise<void> {
  return readBack(key, (_, fresh) => {
    nextFocus.delete(key);
    if (fresh.notFound) patch(key, { busy: false, conflict: "deleted" });
    else patch(key, { busy: false, failure: "Could not reload: the file on disk is no longer text this tab can edit." });
    focusEditor(key);
  });
}

/** Discard: the draft goes, as asked. Against a file that moved on, that means what is on disk now, or leaving edit mode when there is nothing to show. */
export async function discardDraft(key: string): Promise<void> {
  const s = session(key);
  if (!s?.view || s.busy) return;
  if (s.conflict === "deleted") end(key);
  else if (s.conflict) {
    await readBack(key, () => {
      end(key);
    });
  } else if (s.dirty) adopt(key, s, s.view);
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
  editors.delete(key);
  if (s.dirty) return;
  forgetDraft(stateKey);
  patch(key, { view: null, seed: "", stateKey: nextStateKey() });
}

/**
 * An editor is about to open on `stateKey`. A dirty draft should be waiting in the library;
 * if its memory pushed the draft out, the tab must not pretend: it says so, on the last
 * version it knows.
 */
export function editorOpening(key: string, stateKey: string): void {
  const s = session(key);
  if (s?.stateKey !== stateKey || !s.dirty || !s.view || draftText(stateKey) !== null) return;
  adopt(key, s, s.view);
  patch(key, { failure: DRAFT_LOST });
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
  if (answer === "cancel") {
    // After the dialog hands focus back, which it cannot do into a shadow root.
    requestAnimationFrame(() => {
      focusEditor(key);
    });
    return false;
  }
  if (answer === "alternate") return true;
  if ((await saveFile(key)) === "saved") return true;
  activatePanelTab(panelKey, tab.id);
  return false;
}

/**
 * The session cmd+S means. The editor with the keyboard, if there is one: group focus moves
 * without it, so the focused group's tab may be another file. Otherwise the focused group's
 * active tab, if it is really on screen: a draft the user cannot see is not saved.
 */
function focusedEdit(): string | null {
  const focused = editorWithFocus();
  if (focused !== null) return focused;
  const panelKey = keyOf(useUiStore.getState().selection);
  if (panelKey === null) return null;
  const entry = getPanel(panelKey);
  const tab = entry.open ? activeTab(entry) : null;
  const key = tab ? fileEditKey(panelKey, tab.id) : null;
  return key !== null && editors.has(key) ? key : null;
}

/** Whether file.save would do anything here: the palette lists it only then. */
export function canSaveFile(): boolean {
  return focusedEdit() !== null;
}

/** file.save in this window. With nothing to save, nothing happens; the command is still handled. */
export function presentFileSave(): boolean {
  const key = focusedEdit();
  if (key !== null) void saveFile(key);
  return true;
}
