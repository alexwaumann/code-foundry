/**
 * The library's editor, loaded on first use: `@pierre/diffs/edit` is a chunk of its own, so
 * only a tab that edits pays for it (the viewer and every thread row stay on the read-only
 * `@pierre/diffs/react`). Everything that touches the editor's code goes through here.
 *
 * A draft is the library's: its `EditStateManager` keeps each `editStateKey`'s document
 * and undo history in memory, also while the tab is not on screen. Nothing else holds the
 * edited text, and nothing writes it anywhere but FilesystemService.WriteFile. A reader that
 * follows the text as it changes subscribes here (`subscribeDraft`, `draftSnapshot`): every
 * editor made through `createCodeEditor` reports its changes by its key.
 */
import type { EditorFactory } from "@pierre/diffs/react";

type EditModule = typeof import("@pierre/diffs/edit");

/** The library's editor, as the file view attaches it. */
export type CodeEditor = InstanceType<EditModule["Editor"]>;

/** A place in a document, zero-based. */
export interface EditorPlace {
  line: number;
  character: number;
}

/** What the app asks of an editor on screen. */
export interface EditorHandle {
  /** Takes the keyboard, at a place or where the caret was, and scrolls the caret into view. */
  focus: (at?: EditorPlace) => void;
  /**
   * Takes the keyboard without moving the view (the pencil, Discard, Reload): the caret at `at`,
   * a place on screen; with none, where the caret was.
   */
  focusInPlace: (at: EditorPlace | null) => void;
  /** Where the caret is; null before there is one. */
  caret: () => EditorPlace | null;
  /** Selects from one place to another (on one line: a find's match) and takes the keyboard. */
  select: (from: EditorPlace, to: EditorPlace) => void;
}

export function editorHandle(editor: Pick<CodeEditor, "focus" | "getViewState" | "setSelections">): EditorHandle {
  return {
    focus: (at) => {
      editor.focus(at && { lineNumber: at.line + 1, character: at.character });
    },
    // Without preventScroll the library scrolls to the caret, which a new document has at line 1.
    focusInPlace: (at) => {
      editor.focus(at ? { lineNumber: at.line + 1, character: at.character, preventScroll: true } : { preventScroll: true });
    },
    caret: () => {
      const s = editor.getViewState().selections?.at(-1);
      if (!s) return null;
      const { line, character } = s.direction === -1 ? s.start : s.end;
      return { line, character };
    },
    select: (from, to) => {
      editor.setSelections([{ start: from, end: to, direction: "forward" }]);
      editor.focus({ preventScroll: true });
    },
  };
}

let edit: EditModule | null = null;

/** Loads the editor. Call before a CodeFile turns `edit.active` on. */
export async function loadCodeEditor(): Promise<void> {
  edit ??= await import("@pierre/diffs/edit");
}

/** A key's readers, and its text as last read (undefined: read it again). */
interface DraftWatch {
  listeners: Set<() => void>;
  text: string | null | undefined;
}

const watches = new Map<string, DraftWatch>();

function draftChanged(stateKey: string): void {
  const w = watches.get(stateKey);
  if (!w) return;
  w.text = undefined;
  for (const l of [...w.listeners]) l();
}

/** EditProvider's createEditor: the editor also tells `subscribeDraft`'s readers of each change. */
export const createCodeEditor: EditorFactory<undefined, undefined> = (type, options, key) => {
  if (!edit) throw new Error("loadCodeEditor has not finished");
  if (key === undefined) return new edit.Editor(type, options, key);
  const onChange = options.onChange;
  return new edit.Editor(
    type,
    {
      ...options,
      onChange: (event) => {
        onChange?.(event);
        draftChanged(key);
      },
    },
    key,
  );
};

/** Calls `onChange` after each change to `stateKey`'s document; returns the stop (useSyncExternalStore's subscribe). */
export function subscribeDraft(stateKey: string, onChange: () => void): () => void {
  let w = watches.get(stateKey);
  if (!w) {
    w = { listeners: new Set(), text: undefined };
    watches.set(stateKey, w);
  }
  const watch = w;
  watch.listeners.add(onChange);
  return () => {
    watch.listeners.delete(onChange);
    if (watch.listeners.size === 0 && watches.get(stateKey) === watch) watches.delete(stateKey);
  };
}

/**
 * `draftText` for a reader subscribed to the key: read once per change, so React may ask
 * as often as it likes (the document has no cached text: each read joins its pieces). A key
 * with no document yet is read again next time: an editor that attaches says nothing.
 */
export function draftSnapshot(stateKey: string): string | null {
  const w = watches.get(stateKey);
  if (!w) return draftText(stateKey);
  if (w.text === undefined || w.text === null) w.text = draftText(stateKey);
  return w.text;
}

/** A draft's text, from the editor on screen or the one its tab left; null when there is none. */
export function draftText(stateKey: string): string | null {
  return edit?.EditStateManager.get("file", stateKey)?.document.getText() ?? null;
}

/** Drops a draft the library keeps for a detached editor (one still attached stays: call again when it goes). */
export function forgetDraft(stateKey: string): void {
  edit?.EditStateManager.clear("file", stateKey);
}
