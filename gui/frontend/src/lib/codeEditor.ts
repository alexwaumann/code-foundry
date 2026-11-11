/**
 * The library's editor, loaded on first use: `@pierre/diffs/edit` is a chunk of its own, so
 * only a tab that edits pays for it (the viewer and every thread row stay on the read-only
 * `@pierre/diffs/react`). Everything that touches the editor's code goes through here.
 *
 * A draft is the library's: its `EditStateManager` keeps each `editStateKey`'s document
 * and undo history in memory, also while the tab is not on screen. Nothing else holds the
 * edited text, and nothing writes it anywhere but FilesystemService.WriteFile.
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
  /** Takes the keyboard, at a place or where the caret was. */
  focus: (at?: EditorPlace) => void;
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

/** EditProvider's createEditor. */
export const createCodeEditor: EditorFactory<undefined, undefined> = (type, options, key) => {
  if (!edit) throw new Error("loadCodeEditor has not finished");
  return new edit.Editor(type, options, key);
};

/** A draft's text, from the editor on screen or the one its tab left; null when there is none. */
export function draftText(stateKey: string): string | null {
  return edit?.EditStateManager.get("file", stateKey)?.document.getText() ?? null;
}

/** Drops a draft the library keeps for a detached editor (one still attached stays: call again when it goes). */
export function forgetDraft(stateKey: string): void {
  edit?.EditStateManager.clear("file", stateKey);
}
