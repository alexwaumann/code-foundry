import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref } from "react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { splitBlock } from "@tiptap/pm/commands";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { findTrigger, LEAF_CHAR, type TriggerChar } from "@/lib/completion";
import { phraseAtCaret } from "@/lib/dictation";
import { spacedAtCaret } from "@/lib/droppedPaths";
import { chipInsertText, chipToken, parseLine, parsePrompt, proseOf, serializePrompt, type PromptPiece, type PromptTag } from "@/lib/prompt";
import { DictationLanding, dictationLandingKey, expireMeta, LANDED_MS, landedMeta, markerMeta } from "./dictationLanding";
import { TagDraftContext, TAG_NODE, tagAttrs, tagOf } from "./tagContext";
import { TagNode } from "./tagNode";
import { selectedChipId } from "./tagSelection";

/** A completion trigger at the caret: the character, the query, and the document range of both. */
export interface EditorTrigger {
  char: TriggerChar;
  query: string;
  from: number;
  to: number;
}

/** Keys the completion card takes while it is open. */
export type CompletionKey = "up" | "down" | "enter" | "tab" | "escape";

export interface PromptEditorHandle {
  focus(): void;
  /**
   * Puts chips for newly attached images into the text at the caret (T3 Code's rule:
   * only when the prompt has prose already or a selection is being replaced).
   */
  insertChips(attachments: readonly { id: string; name: string }[]): void;
  /**
   * Replaces a range (a trigger and its query) with a tag and one space after it (or
   * steps over the space already there): a slash command and a file reference end at
   * whitespace. One undo step.
   */
  insertTag(range: { from: number; to: number }, tag: PromptTag): void;
  /** insertTag for plain text (a built-in slash command: "/compact"): the text and one space, one undo step. */
  insertText(range: { from: number; to: number }, text: string): void;
  /**
   * Puts a citation tag at the caret (the end of the prompt when it was never focused),
   * a space before it unless whitespace is there and one after it, and focuses the
   * prompt after it. One undo step.
   */
  insertCite(citationId: string): void;
  /** Focuses the prompt with the selection collapsed to its end (a clicked tag is no longer selected). */
  focusCollapsed(): void;
  /**
   * Puts plain text (dropped or picked paths) at the caret, replacing a selection (the
   * end of the prompt when it was never focused), with a space on either side where the
   * text would otherwise touch a word (lib/droppedPaths spacedAtCaret), and leaves the
   * caret after it. One undo step. Does nothing while the prompt is disabled.
   */
  insertPlain(text: string): void;
  /**
   * Puts a dictated phrase at the caret (the end of the prompt when it was never focused)
   * with a space before it unless the caret follows whitespace or starts the line
   * (lib/dictation phraseAtCaret), tinted while it fades in (dictationLanding.ts), and
   * leaves the caret after it. Does not take focus. One undo step.
   */
  insertDictated(text: string): void;
  /** Shows or hides the dot after the caret where the next dictated phrase lands. */
  setDictationMarker(on: boolean): void;
}

interface PromptEditorProps {
  /** The draft (draftKey) the prompt belongs to. */
  draftKey: string;
  /** The prompt with chip tokens (lib/prompt.ts); the store's copy is the source of truth. */
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (text: string) => void;
  /** Enter (without Shift): send. */
  onSubmit: () => void;
  /** Escape; return true when handled. Absent: Escape is left alone. */
  onEscape?: () => boolean;
  /** Pasted image files (a paste with files inserts no text). */
  onPasteFiles: (files: File[]) => void;
  /** Space on a selected chip: preview its attachment; false when it has none. */
  onPreviewChip: (id: string, returnFocus: HTMLElement) => boolean;
  /** The characters that start a completion ([] for none). */
  triggers: readonly TriggerChar[];
  /** The trigger at the caret changed (null: none, or the prompt lost focus). */
  onTrigger: (t: EditorTrigger | null) => void;
  /** A completion key; true when the open card took it. */
  onCompletionKey: (key: CompletionKey) => boolean;
  /** The open card's listbox and active option ids, for aria-controls / aria-activedescendant. */
  completionAria: { controls: string; active: string } | null;
  /**
   * Every key first, ahead of the completion card and the editor's own keys (the previous
   * prompts picker: Up in the empty prompt, then its card's keys); true when taken.
   * `selectionEmpty`: nothing is selected in the prompt.
   */
  onKeyDown?: (e: KeyboardEvent, selectionEmpty: boolean) => boolean;
  handleRef: Ref<PromptEditorHandle>;
}

function piecesToNodes(pieces: readonly PromptPiece[]): JSONContent[] {
  return pieces.map((p) => (p.kind === "text" ? { type: "text", text: p.text } : { type: TAG_NODE, attrs: { ...tagAttrs(p) } }));
}

/** The trigger at a collapsed caret, if any. */
function triggerAt(state: EditorState, chars: readonly TriggerChar[]): EditorTrigger | null {
  const sel = state.selection;
  if (!sel.empty || chars.length === 0) return null;
  const { $from } = sel;
  // Leaves (tags) are one position and one LEAF_CHAR each, so offsets map to positions.
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, LEAF_CHAR);
  const t = findTrigger(before, chars);
  return t && { char: t.char, query: t.query, from: $from.start() + t.offset, to: $from.pos };
}

function sameTrigger(a: EditorTrigger | null, b: EditorTrigger | null): boolean {
  return a === b || (a !== null && b !== null && a.char === b.char && a.query === b.query && a.from === b.from && a.to === b.to);
}

/** The completion key an event is (plain keys only), or null. */
function completionKey(e: KeyboardEvent): CompletionKey | null {
  if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return null;
  switch (e.key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "Enter":
      return "enter";
    case "Tab":
      return "tab";
    case "Escape":
      return "escape";
    default:
      return null;
  }
}

function toDoc(text: string): JSONContent {
  return { type: "doc", content: parsePrompt(text).map((line) => (line.length > 0 ? { type: "paragraph", content: piecesToNodes(line) } : { type: "paragraph" })) };
}

/** Inline content of a node as prompt pieces. */
function inlinePieces(parent: PMNode | Fragment): PromptPiece[] {
  const out: PromptPiece[] = [];
  parent.forEach((n) => {
    if (n.isText) out.push({ kind: "text", text: n.text ?? "" });
    else if (n.type.name === TAG_NODE) out.push({ kind: "tag", ...tagOf(n.attrs) });
  });
  return out;
}

/** A fragment (the document, or a copied slice) as the prompt string. */
function fragmentText(content: Fragment): string {
  const lines: PromptPiece[][] = [];
  let inline: PromptPiece[] | null = null;
  for (const n of content.content) {
    if (n.isTextblock) {
      if (inline) lines.push(inline);
      inline = null;
      lines.push(inlinePieces(n));
    } else {
      inline ??= [];
      inline.push(...inlinePieces(Fragment.from(n)));
    }
  }
  if (inline) lines.push(inline);
  return serializePrompt(lines);
}

/** Plain text (chip tokens become chips) as a slice that merges into the paragraph at the caret. */
function textSlice(view: EditorView, text: string): Slice {
  const { schema } = view.state;
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => schema.nodeFromJSON(line ? { type: "paragraph", content: piecesToNodes(parseLine(line)) } : { type: "paragraph" }));
  return Slice.maxOpen(Fragment.from(paragraphs));
}

/**
 * The prompt input: a TipTap (ProseMirror) editor with paragraphs, text and inline tags
 * (image chips, skills, files), nothing else (no marks, no Markdown). Enter sends,
 * Shift+Enter starts a new line; Space on a selected image chip previews it; tags are
 * atoms, so Backspace/Delete remove one whole and the arrows step over one in a single
 * press; undo restores a deleted tag. Copy writes the token text; a pasted token becomes
 * a tag again. A trigger character (`/`) at the caret is reported to the composer, whose
 * completion card then takes the arrows, Enter, Tab and Escape while it is open.
 */
export function PromptEditor({
  draftKey,
  value,
  disabled,
  placeholder,
  onChange,
  onSubmit,
  onEscape,
  onPasteFiles,
  onPreviewChip,
  triggers,
  onTrigger,
  onCompletionKey,
  completionAria,
  onKeyDown,
  handleRef,
}: PromptEditorProps) {
  // What the editor last reported (or was set to): a store value that differs came from
  // outside (a removed attachment, a cleared draft) and replaces the document.
  const shown = useRef(value);
  const focused = useRef(false);
  const lastTrigger = useRef<EditorTrigger | null>(null);
  const cb = useRef({ onChange, onSubmit, onEscape, onPasteFiles, onPreviewChip, onTrigger, onCompletionKey, onKeyDown, triggers, disabled });
  useLayoutEffect(() => {
    cb.current = { onChange, onSubmit, onEscape, onPasteFiles, onPreviewChip, onTrigger, onCompletionKey, onKeyDown, triggers, disabled };
  });

  /** Reports the trigger at the caret when it changed (none without focus or while disabled). */
  const report = (state: EditorState | null) => {
    const t = state && !cb.current.disabled ? triggerAt(state, cb.current.triggers) : null;
    if (sameTrigger(t, lastTrigger.current)) return;
    lastTrigger.current = t;
    cb.current.onTrigger(t);
  };

  const controls = completionAria?.controls;
  const active = completionAria?.active;
  const attributes = useMemo(
    () => ({
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": "Prompt",
      "aria-placeholder": placeholder,
      ...(disabled ? { "aria-disabled": "true" } : {}),
      ...(triggers.length > 0 ? { "aria-autocomplete": "list" } : {}),
      ...(controls ? { "aria-controls": controls } : {}),
      ...(active ? { "aria-activedescendant": active } : {}),
      "data-compose-stop": "",
      "data-testid": "composer-input",
      class: "min-h-16 max-h-80 overflow-y-auto px-4 pt-3.5 pb-1 text-body whitespace-pre-wrap break-words outline-none aria-disabled:opacity-70",
    }),
    [disabled, placeholder, triggers.length, controls, active],
  );

  const editor = useEditor({
    extensions: [Document, Paragraph, Text, UndoRedo, TagNode, DictationLanding],
    content: toDoc(value),
    editable: !disabled,
    editorProps: {
      attributes,
      handleKeyDown: (view, e) => {
        if (e.isComposing) return false;
        if (!cb.current.disabled && cb.current.onKeyDown?.(e, view.state.selection.empty)) return true;
        const ck = completionKey(e);
        // The open completion card first: Enter inserts there instead of sending.
        if (ck && cb.current.onCompletionKey(ck)) return true;
        const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
        if (e.key === "Enter") {
          if (e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) return splitBlock(view.state, (tr) => {
            view.dispatch(tr.scrollIntoView());
          });
          if (!e.altKey) {
            cb.current.onSubmit();
            return true;
          }
          return false;
        }
        if (e.key === "Escape" && plain) return cb.current.onEscape?.() ?? false;
        const sel = view.state.selection;
        // Space on a selected chip (clicked, or Shift+Arrow over it) previews its image
        // instead of replacing it. Enter is left alone: it sends.
        if (e.key === " " && plain) {
          const id = selectedChipId(sel);
          return id !== null && cb.current.onPreviewChip(id, view.dom);
        }
        if (!sel.empty || !plain) return false;
        const { $from } = sel;
        // Step over a tag in one press (ProseMirror would select it first).
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          const next = dir < 0 ? $from.nodeBefore : $from.nodeAfter;
          if (next?.type.name !== TAG_NODE) return false;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $from.pos + dir * next.nodeSize)).scrollIntoView());
          return true;
        }
        // Backspace/Delete next to a tag remove exactly it (the same in WebKit and Chromium).
        if (e.key === "Backspace" || e.key === "Delete") {
          const back = e.key === "Backspace";
          const next = back ? $from.nodeBefore : $from.nodeAfter;
          if (next?.type.name !== TAG_NODE) return false;
          const from = back ? $from.pos - next.nodeSize : $from.pos;
          view.dispatch(view.state.tr.delete(from, from + next.nodeSize).scrollIntoView());
          return true;
        }
        return false;
      },
      handlePaste: (view, e) => {
        const data = e.clipboardData;
        if (!data) return false;
        const files = Array.from(data.files);
        if (files.length > 0) {
          cb.current.onPasteFiles(files);
          return true;
        }
        // Plain text only: no HTML structure or marks come in.
        const text = data.getData("text/plain");
        if (text) view.dispatch(view.state.tr.replaceSelection(textSlice(view, text)).scrollIntoView());
        return true;
      },
      // Files dropped on the editor are the card's to attach (components/compose/Composer.tsx).
      handleDrop: (_view, e) => (e.dataTransfer?.files.length ?? 0) > 0,
      clipboardTextSerializer: (slice) => fragmentText(slice.content),
    },
    onUpdate: ({ editor: ed }) => {
      const text = fragmentText(ed.state.doc.content);
      if (text !== shown.current) {
        shown.current = text;
        cb.current.onChange(text);
      }
      report(ed.view.hasFocus() ? ed.state : null);
    },
    onSelectionUpdate: ({ editor: ed }) => {
      report(ed.view.hasFocus() ? ed.state : null);
    },
    onFocus: ({ editor: ed }) => {
      focused.current = true;
      report(ed.state);
    },
    onBlur: () => {
      report(null);
    },
  });

  useEffect(() => {
    editor.setEditable(!disabled, false);
    if (disabled) report(null);
  }, [editor, disabled]);

  useLayoutEffect(() => {
    if (!editor.isInitialized) return;
    editor.view.setProps({ attributes });
  }, [editor, attributes]);

  // A value from outside: rebuild the document (not an undo step), caret at the end.
  useLayoutEffect(() => {
    if (value === shown.current) return;
    shown.current = value;
    editor.chain().setMeta("addToHistory", false).setContent(toDoc(value), { emitUpdate: false }).setTextSelection(editor.state.doc.content.size).run();
  }, [editor, value]);

  useImperativeHandle(
    handleRef,
    () => ({
      // Synchronous: TipTap's focus command focuses again a frame later, which takes the
      // keyboard back from whatever got it meanwhile (cmd+k right after a thread is
      // selected would lose the palette to its prompt).
      focus: () => {
        if (editor.isDestroyed) return;
        try {
          editor.view.focus();
          editor.commands.scrollIntoView();
        } catch {
          editor.commands.focus();
        }
      },
      insertChips: (attachments) => {
        const { state } = editor;
        const tokens = attachments.map((a) => chipToken(a.id, a.name));
        const replacing = focused.current && !state.selection.empty;
        // Unknown caret (never focused): the end of the prompt.
        const end = TextSelection.atEnd(state.doc);
        const sel = focused.current ? state.selection : end;
        const before = sel.$from.parent.textBetween(0, sel.$from.parentOffset, undefined, LEAF_CHAR);
        const insert = chipInsertText(tokens, before, { hasProse: proseOf(shown.current).trim() !== "", replacingSelection: replacing });
        if (insert === null) return;
        editor.chain().insertContentAt({ from: sel.from, to: sel.to }, piecesToNodes(parseLine(insert))).run();
      },
      insertTag: (range, tag) => {
        const { doc } = editor.state;
        const end = doc.resolve(range.to).end();
        const spaced = doc.textBetween(range.to, Math.min(range.to + 1, end), undefined, LEAF_CHAR) === " ";
        const nodes = piecesToNodes(spaced ? [{ kind: "tag", ...tag }] : [{ kind: "tag", ...tag }, { kind: "text", text: " " }]);
        // The caret ends after the space: the inserted one, or the one already there.
        editor
          .chain()
          .focus()
          .insertContentAt(range, nodes)
          .setTextSelection(range.from + 2)
          .scrollIntoView()
          .run();
      },
      insertCite: (citationId) => {
        if (editor.isDestroyed) return;
        const { state } = editor;
        const at = focused.current ? state.selection.to : TextSelection.atEnd(state.doc).to;
        const $at = state.doc.resolve(at);
        const before = $at.parent.textBetween(0, $at.parentOffset, undefined, LEAF_CHAR);
        const after = $at.parent.textBetween($at.parentOffset, Math.min($at.parentOffset + 1, $at.parent.content.size), undefined, LEAF_CHAR);
        const pieces: PromptPiece[] = [];
        if (before !== "" && !/\s$/.test(before)) pieces.push({ kind: "text", text: " " });
        pieces.push({ kind: "tag", tagKind: "cite", id: citationId });
        if (after !== " ") pieces.push({ kind: "text", text: " " });
        const size = pieces.length + (after === " " ? 1 : 0);
        editor
          .chain()
          .focus()
          .insertContentAt({ from: at, to: at }, piecesToNodes(pieces))
          .setTextSelection(at + size)
          .scrollIntoView()
          .run();
      },
      focusCollapsed: () => {
        if (editor.isDestroyed) return;
        editor.chain().focus().setTextSelection(editor.state.selection.to).run();
      },
      insertPlain: (text) => {
        if (editor.isDestroyed || !editor.isEditable || text === "") return;
        const { state } = editor;
        const sel = focused.current ? state.selection : TextSelection.atEnd(state.doc);
        const { $from, $to } = sel;
        const before = $from.parent.textBetween(0, $from.parentOffset, undefined, LEAF_CHAR);
        const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, LEAF_CHAR);
        const insert = spacedAtCaret(text, before, after);
        editor
          .chain()
          .focus()
          .insertContentAt({ from: sel.from, to: sel.to }, { type: "text", text: insert })
          .setTextSelection(sel.from + insert.length)
          .scrollIntoView()
          .run();
      },
      insertDictated: (text) => {
        if (editor.isDestroyed) return;
        const { state } = editor;
        const sel = focused.current ? state.selection : TextSelection.atEnd(state.doc);
        const { $from, $to } = sel;
        const before = $from.parent.textBetween(0, $from.parentOffset, undefined, LEAF_CHAR);
        const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, LEAF_CHAR);
        const insert = phraseAtCaret(text, before, after);
        if (insert === "") return;
        const lead = insert.length - insert.trimStart().length;
        const words = insert.trim().length;
        const at = Date.now();
        const tr = state.tr.insertText(insert, sel.from, sel.to);
        const start = sel.from + lead;
        tr.setSelection(TextSelection.create(tr.doc, sel.from + insert.length));
        tr.setMeta(dictationLandingKey, landedMeta(start, start + words, at));
        editor.view.dispatch(tr.scrollIntoView());
        setTimeout(() => {
          if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(dictationLandingKey, expireMeta(at)));
        }, LANDED_MS + 100);
      },
      setDictationMarker: (on) => {
        if (editor.isDestroyed || dictationLandingKey.getState(editor.state)?.marker === on) return;
        editor.view.dispatch(editor.state.tr.setMeta(dictationLandingKey, markerMeta(on)));
      },
      insertText: (range, text) => {
        const { doc } = editor.state;
        const end = doc.resolve(range.to).end();
        const spaced = doc.textBetween(range.to, Math.min(range.to + 1, end), undefined, LEAF_CHAR) === " ";
        editor
          .chain()
          .focus()
          .insertContentAt(range, { type: "text", text: spaced ? text : `${text} ` })
          .setTextSelection(range.from + text.length + 1)
          .scrollIntoView()
          .run();
      },
    }),
    [editor],
  );

  return (
    <TagDraftContext.Provider value={draftKey}>
      {/* data-value: the prompt as stored (tag tokens included), for tests and debugging. */}
      <div className="relative" data-testid="composer-prompt" data-value={value}>
        {value === "" && (
          <span aria-hidden className="pointer-events-none absolute top-3.5 left-4 text-body text-cf-placeholder select-none">
            {placeholder}
          </span>
        )}
        <EditorContent editor={editor} />
      </div>
    </TagDraftContext.Provider>
  );
}
