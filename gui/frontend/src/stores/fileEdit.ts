/**
 * Editing a file in the File tab (docs/notes/file-edit-2-gui.md): one session per file per
 * thread (its key is the thread's panel key, "" for an unlinked tab, and the file's path), so
 * the session follows the file's identity, not its place: a tab that moves to another pane or
 * space, or is put away with its thread and comes back, finds its draft again.
 *
 * Unsaved edits are never discarded unless the user says so (docs/notes/shell-review-fixes-gui.md):
 * a session whose tab is gone ends only when it is clean. A dirty one waits for its file to be
 * opened again for that thread; the user's own closes that would end it for good ask first
 * (stores/fileRequest.ts confirmCloseFile, confirmEndEdits).
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
import { blankFile, canEdit, readFile, versionStamp, writeFile, type FileReadView } from "@/api/files";
import { errorMessage } from "@/api/stream";
import { draftText, forgetDraft, loadCodeEditor, type EditorHandle, type EditorPlace } from "@/lib/codeEditor";
import { deepActiveElement } from "@/lib/keyTarget";
import { findTab, setTabParams, shownTab, tabPlace, targetOf } from "@/shell/host";
import { fileOfTab, fileTab } from "@/surfaces/fileTarget";
import { useLayoutStore, type LayoutState, type TabEntry } from "./layout";
import { useUiStore } from "./ui";

/** What is wrong with the draft's baseline: the file was changed, or is gone. */
export type EditConflict = "changed" | "deleted";

/** Where a file really is and who can read it. */
export type FileWhere = Pick<FileReadView, "path" | "realPath" | "mode">;

export interface FileEdit {
  panelKey: string;
  tabId: string;
  /** The tab's checkout, as for readFile. */
  base: string;
  /** The resolved path it started on, for good: every read and write of the session is of this file. */
  path: string;
  /** What the latest read says of the file's place, kept apart from `view`: a chmod or a new link moves neither size nor time, and the baseline must not move. */
  where: FileWhere;
  /** No file is there yet: the document is empty to start with, and a save makes the file, never replacing one that appeared. */
  creating: boolean;
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

/** A tab's session key: the panel key of its thread ("" for none) and the File tab's seam id (its path). */
export function fileEditKey(panelKey: string, tabId: string): string {
  return `${panelKey}\u0000${tabId}`;
}

/** The session key of a layout File tab, wherever it is; null for any other tab. */
export function fileEditKeyOfTab(tab: Pick<TabEntry, "kind" | "thread" | "params">): string | null {
  if (tab.kind !== "file") return null;
  const target = fileOfTab(tab);
  return target ? fileEditKey(tab.thread ? `thread:${tab.thread}` : "", fileTab(target).id) : null;
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

/** The tab's session right now, outside a render. */
export function fileEditOf(key: string): FileEdit | undefined {
  return session(key);
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
const nextFocus = new Map<string, EditorPlace | { lineEnd: number } | null>();

/** The end of a zero-based line of the tab's document; of its last line past the end. */
function lineEnd(key: string, line: number): EditorPlace {
  const s = session(key);
  const lines = ((s && draftText(s.stateKey)) ?? s?.seed ?? "").split("\n");
  const at = Math.min(line, lines.length - 1);
  return { line: at, character: (lines[at] ?? "").replace(/\r$/, "").length };
}

/** The tab's editor is on screen. It takes the keyboard if it was asked to. */
export function noteEditor(key: string, editor: EditorHandle): void {
  editors.set(key, editor);
  const at = nextFocus.get(key);
  if (at === undefined) return;
  nextFocus.delete(key);
  editor.focus(at === null ? undefined : "lineEnd" in at ? lineEnd(key, at.lineEnd) : at);
}

/** Puts the keyboard back in the tab's editor, if it is on screen. */
export function focusEditor(key: string): void {
  editors.get(key)?.focus();
}

/** Selects a span of the tab's document and gives its editor the keyboard (a find's match as the find closes). False with no editor on screen. */
export function selectInEditor(key: string, from: EditorPlace, to: EditorPlace): boolean {
  const editor = editors.get(key);
  editor?.select(from, to);
  return editor !== undefined;
}

/** The next editor of this tab takes the keyboard (the pencil, Discard, Reload). */
export function focusNextEditor(key: string): void {
  nextFocus.set(key, null);
}

/** The tab's editor takes the keyboard at the end of a 1-based line, now or when it is on screen (a thread's --focus). */
export function focusEditorLine(key: string, line: number | undefined): void {
  const editor = editors.get(key);
  if (editor) editor.focus(line === undefined ? undefined : lineEnd(key, line - 1));
  else nextFocus.set(key, line === undefined ? null : { lineEnd: line - 1 });
}

/** The session whose editor has the keyboard (its find field too); null when none does. */
function editorWithFocus(): string | null {
  const stateKey = document.activeElement?.closest("[data-code-editor]")?.getAttribute("data-code-editor");
  if (!stateKey) return null;
  const found = Object.entries(useFileEditStore.getState().sessions).find(([, s]) => s.stateKey === stateKey);
  return found ? found[0] : null;
}

/** The keyboard is in an editor's find field, not its document. */
function findHasKeyboard(): boolean {
  return deepActiveElement()?.closest("[data-search-panel]") != null;
}

// The palette's input has the keyboard while it is open, so cmd+S's rule cannot see the
// editor that had it: that is kept here from the moment the palette opens, before it mounts.
let paletteEditor: string | null = null;

useUiStore.subscribe((s, prev) => {
  if (s.palette.open && !prev.palette.open) paletteEditor = editorWithFocus();
});

/** The edit session whose editor has the keyboard (its find field too); null when none does. */
export function typingIn(): FileEdit | null {
  const at = editorWithFocus();
  return (at !== null && session(at)) || null;
}

/** The session whose editor the user was in: the palette's, while it covers the window. */
function editorInUse(): string | null {
  if (!useUiStore.getState().palette.open) return editorWithFocus();
  return paletteEditor !== null && session(paletteEditor) ? paletteEditor : null;
}

/** The palette is closing on a command that was for this editor: the keyboard goes back in, which the palette's focus return cannot do through a shadow root. */
export function returnFromPalette(key: string): void {
  if (!useUiStore.getState().palette.open || paletteEditor !== key) return;
  requestAnimationFrame(() => {
    focusEditor(key);
  });
}

/** Ends a session and drops its draft (an editor still on screen drops it in editorDetached). */
function end(key: string): void {
  const was = session(key);
  if (!was) return;
  editors.delete(key);
  nextFocus.delete(key);
  heldReads.delete(key);
  useFileEditStore.setState((s) => {
    const { [key]: _gone, ...rest } = s.sessions;
    return { sessions: rest };
  });
  forgetDraft(was.stateKey);
}

/**
 * The user said to throw the session's unsaved edits away (Discard in a close question): it ends,
 * draft and all, whether or not its tab is open.
 */
export function discardEdit(key: string): void {
  end(key);
}

/** The sessions with unsaved edits whose keys `keep` accepts (a thread's: its panel key). */
export function dirtyEdits(keep: (s: FileEdit) => boolean): string[] {
  return Object.entries(useFileEditStore.getState().sessions).flatMap(([key, s]) => (s.dirty && keep(s) ? [key] : []));
}

/** The session keys of every File tab in the layout, in any space. */
function liveKeys(l: Pick<LayoutState, "tabs">): Set<string> {
  const out = new Set<string>();
  for (const t of Object.values(l.tabs)) {
    const key = fileEditKeyOfTab(t);
    if (key !== null) out.add(key);
  }
  return out;
}

/**
 * Whatever removes a File tab (a close, its thread put away, a model's tab.close, a removed
 * space), a clean session goes with it. A dirty one stays: its draft waits in the library for the
 * file to be opened again for the same thread. Run when the tabs change and when a session does
 * (a save leaves a tab-less session clean).
 */
function prune(): void {
  const l = useLayoutStore.getState();
  if (!l.loaded) return;
  const live = liveKeys(l);
  for (const [key, s] of Object.entries(useFileEditStore.getState().sessions)) {
    if (!s.dirty && !s.busy && !live.has(key)) end(key);
  }
}

useLayoutStore.subscribe((l, prev) => {
  if (l.tabs !== prev.tabs) prune();
});
useFileEditStore.subscribe((s, prev) => {
  if (s.sessions !== prev.sessions && Object.entries(s.sessions).some(([key, x]) => !x.dirty && !x.busy && (prev.sessions[key]?.dirty === true || prev.sessions[key]?.busy === true))) prune();
});

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

function whereOf(view: FileReadView): FileWhere {
  return { path: view.path, realPath: view.realPath, mode: view.mode };
}

function sameVersion(a: FileReadView, b: FileReadView): boolean {
  return a.size === b.size && a.modifiedAtMs === b.modifiedAtMs;
}

/** The session starts over on `view`: a new document, nothing to save, nothing wrong. `creating`: still no file behind it. */
function adopt(key: string, was: FileEdit, view: FileReadView, creating = false): void {
  clock += 1;
  forgetDraft(was.stateKey);
  patch(key, { creating, where: view === was.view ? was.where : whereOf(view), view, seed: view.text ?? "", stateKey: nextStateKey(), revision: was.revision + 1, dirty: false, conflict: null, failure: null, busy: false, readsFrom: clock });
}

// A read a find field kept off the screen: a new document would close the field under the
// user's fingers and leave the keyboard nowhere. It lands when the field lets go. Nothing
// says so: the library's field closes without a focus event anyone outside it can hear, and
// the keyboard goes to the body. So it is looked for, only while a read is held.
const heldReads = new Map<string, FileReadView>();
const HELD_READ_CHECK_MS = 200;
let heldReadCheck: ReturnType<typeof setInterval> | undefined;

function holdRead(key: string, view: FileReadView): void {
  heldReads.set(key, view);
  heldReadCheck ??= setInterval(landHeldReads, HELD_READ_CHECK_MS);
}

function landHeldReads(): void {
  if (heldReads.size > 0 && findHasKeyboard()) return;
  clearInterval(heldReadCheck);
  heldReadCheck = undefined;
  const held = [...heldReads];
  heldReads.clear();
  for (const [key, view] of held) observeRead(key, view);
}

/**
 * A clean document follows the file. The new editor keeps the keyboard and the caret, if the
 * old one had them. With the keyboard in its find field, the document waits for the field
 * instead: it stays, and what the user types stays in it.
 */
function follow(key: string, was: FileEdit, view: FileReadView): void {
  if (editorWithFocus() === key) {
    if (findHasKeyboard()) {
      holdRead(key, view);
      return;
    }
    nextFocus.set(key, editors.get(key)?.caret() ?? null);
  }
  adopt(key, was, view);
}

/**
 * Turns the editor on for a tab. Loads it first, so the tab flips once it can. A session
 * already there stays: a second click must not reset a draft. `create`: a read that found
 * nothing starts an empty document, which a save makes into the file.
 */
export async function startEdit(key: string, target: { panelKey: string; tabId: string; base: string }, read: FileReadView, opts: { create?: boolean } = {}): Promise<void> {
  await loadCodeEditor();
  const creating = opts.create === true && read.notFound;
  const view = creating ? blankFile(read.path, read.realPath) : read;
  if (session(key) || !canEdit(view)) return;
  useFileEditStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [key]: { ...target, path: view.path, where: whereOf(view), creating, view, seed: view.text ?? "", stateKey: nextStateKey(), revision: 0, dirty: false, conflict: null, failure: null, busy: false, readsFrom: clock },
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
 * A document with no file behind it expects to find nothing; a file that appeared is a
 * conflict like any other, and a clean one follows it.
 */
export function observeRead(key: string, view: FileReadView): void {
  const s = session(key);
  if (!s || s.busy || view.path !== s.path || (readStarts.get(view) ?? Infinity) < s.readsFrom) return;
  if (view !== s.view && (!view.notFound || s.creating) && (view.realPath !== s.where.realPath || view.mode !== s.where.mode)) patch(key, { where: whereOf(view) });
  if (s.creating && view.notFound) {
    if (!s.view) adopt(key, s, blankFile(s.path, view.realPath), true);
    else if (s.conflict !== null) patch(key, { conflict: null });
  } else if (!s.view) {
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

/** Says what went wrong in the tab, as a sentence, in the band a failed save uses. */
export function noteEditFailure(key: string, failure: string): void {
  patch(key, { failure });
}

/** The request standing on a session's tab, by its id (surfaces/fileTarget.ts FileAsk). */
function askIdOf(s: FileEdit): string | undefined {
  return findTab(s.panelKey, s.tabId)?.params.askId;
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
  // Overwrite wins over whatever appeared; anything else must not replace it.
  const how = s.creating && opts.force !== true ? { create: true } : opts;
  const ask = askIdOf(s);
  clock += 1;
  patch(key, { busy: true, failure: null, readsFrom: clock });
  // The answer is about this document: the session may have let it go meanwhile (a clean tab left the screen).
  const current = () => {
    const now = session(key);
    return now?.stateKey === s.stateKey ? now : null;
  };
  try {
    const r = await writeFile(s.base, s.path, text, view, how);
    clock += 1;
    if (!r.conflict && ask !== undefined && askIdOf(s) === ask) setTabParams(s.panelKey, s.tabId, (params) => ({ ...params, askSaved: versionStamp(r) }));
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
    patch(key, { creating: false, view: saved, dirty: draftText(now.stateKey) !== text, conflict: null, busy: false, readsFrom: clock });
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
  return readBack(key, (now, fresh) => {
    nextFocus.delete(key);
    if (fresh.notFound) patch(key, { busy: false, conflict: now.creating ? null : "deleted" });
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
  } else if (s.dirty) adopt(key, s, s.view, s.creating);
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
  heldReads.delete(key);
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
  adopt(key, s, s.view, s.creating);
  patch(key, { failure: DRAFT_LOST });
}

/**
 * The session cmd+S means. The editor with the keyboard, if there is one: group focus moves
 * without it, so the focused group's tab may be another file. Otherwise the focused group's
 * active tab, if it is really on screen: a draft the user cannot see is not saved.
 */
export function focusedEdit(): string | null {
  const focused = editorInUse();
  if (focused !== null) return focused;
  const panelKey = targetOf(useUiStore.getState().selection);
  if (panelKey === null) return null;
  const place = tabPlace(panelKey);
  const tab = place.shown ? shownTab(place) : null;
  const key = tab ? fileEditKey(panelKey, tab.id) : null;
  return key !== null && editors.has(key) ? key : null;
}

/** Whether file.save would do anything here: the palette lists it only then. */
export function canSaveFile(): boolean {
  return focusedEdit() !== null;
}
