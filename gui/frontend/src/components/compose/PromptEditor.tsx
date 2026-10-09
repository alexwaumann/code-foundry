import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref } from "react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { splitBlock } from "@tiptap/pm/commands";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { chipInsertText, chipToken, parseLine, parsePrompt, proseOf, serializePrompt, type PromptPiece } from "@/lib/prompt";
import { ChipRepoContext, CHIP_NODE } from "./chipContext";
import { AttachmentChipNode } from "./chipNode";

export interface PromptEditorHandle {
  focus(): void;
  /**
   * Puts chips for newly attached images into the text at the caret (T3 Code's rule:
   * only when the prompt has prose already or a selection is being replaced).
   */
  insertChips(attachments: readonly { id: string; name: string }[]): void;
}

interface PromptEditorProps {
  repoId: string;
  /** The prompt with chip tokens (lib/prompt.ts); the store's copy is the source of truth. */
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (text: string) => void;
  /** Enter (without Shift): send. */
  onSubmit: () => void;
  /** Escape; return true when handled. */
  onEscape: () => boolean;
  /** Pasted image files (a paste with files inserts no text). */
  onPasteFiles: (files: File[]) => void;
  handleRef: Ref<PromptEditorHandle>;
}

function piecesToNodes(pieces: readonly PromptPiece[]): JSONContent[] {
  return pieces.map((p) => (p.kind === "text" ? { type: "text", text: p.text } : { type: CHIP_NODE, attrs: { id: p.id, name: p.name } }));
}

function toDoc(text: string): JSONContent {
  return { type: "doc", content: parsePrompt(text).map((line) => (line.length > 0 ? { type: "paragraph", content: piecesToNodes(line) } : { type: "paragraph" })) };
}

/** Inline content of a node as prompt pieces. */
function inlinePieces(parent: PMNode | Fragment): PromptPiece[] {
  const out: PromptPiece[] = [];
  parent.forEach((n) => {
    if (n.isText) out.push({ kind: "text", text: n.text ?? "" });
    else if (n.type.name === CHIP_NODE) out.push({ kind: "chip", id: String(n.attrs.id), name: String(n.attrs.name) });
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
 * The prompt input: a TipTap (ProseMirror) editor with paragraphs, text and inline image
 * chips, nothing else (no marks, no Markdown). Enter sends, Shift+Enter starts a new
 * line; chips are atoms, so Backspace/Delete remove one whole and the arrows step over
 * one in a single press; undo restores a deleted chip. Copy writes the token text; a
 * pasted token becomes a chip again.
 */
export function PromptEditor({ repoId, value, disabled, placeholder, onChange, onSubmit, onEscape, onPasteFiles, handleRef }: PromptEditorProps) {
  // What the editor last reported (or was set to): a store value that differs came from
  // outside (a removed attachment, a cleared draft) and replaces the document.
  const shown = useRef(value);
  const focused = useRef(false);
  const cb = useRef({ onChange, onSubmit, onEscape, onPasteFiles });
  useLayoutEffect(() => {
    cb.current = { onChange, onSubmit, onEscape, onPasteFiles };
  });

  const attributes = useMemo(
    () => ({
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": "Prompt",
      "aria-placeholder": placeholder,
      ...(disabled ? { "aria-disabled": "true" } : {}),
      "data-compose-stop": "",
      "data-testid": "composer-input",
      class: "min-h-16 max-h-80 overflow-y-auto px-4 pt-3.5 pb-1 text-sm leading-6 whitespace-pre-wrap break-words outline-none aria-disabled:opacity-70",
    }),
    [disabled, placeholder],
  );

  const editor = useEditor({
    extensions: [Document, Paragraph, Text, UndoRedo, AttachmentChipNode],
    content: toDoc(value),
    editable: !disabled,
    editorProps: {
      attributes,
      handleKeyDown: (view, e) => {
        if (e.isComposing) return false;
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
        if (e.key === "Escape" && plain) return cb.current.onEscape();
        const sel = view.state.selection;
        if (!sel.empty || !plain) return false;
        const { $from } = sel;
        // Step over a chip in one press (ProseMirror would select it first).
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          const next = dir < 0 ? $from.nodeBefore : $from.nodeAfter;
          if (next?.type.name !== CHIP_NODE) return false;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $from.pos + dir * next.nodeSize)).scrollIntoView());
          return true;
        }
        // Backspace/Delete next to a chip remove exactly it (the same in WebKit and Chromium).
        if (e.key === "Backspace" || e.key === "Delete") {
          const back = e.key === "Backspace";
          const next = back ? $from.nodeBefore : $from.nodeAfter;
          if (next?.type.name !== CHIP_NODE) return false;
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
      if (text === shown.current) return;
      shown.current = text;
      cb.current.onChange(text);
    },
    onFocus: () => {
      focused.current = true;
    },
  });

  useEffect(() => {
    editor.setEditable(!disabled, false);
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
      focus: () => {
        editor.commands.focus();
      },
      insertChips: (attachments) => {
        const { state } = editor;
        const tokens = attachments.map((a) => chipToken(a.id, a.name));
        const replacing = focused.current && !state.selection.empty;
        // Unknown caret (never focused): the end of the prompt.
        const end = TextSelection.atEnd(state.doc);
        const sel = focused.current ? state.selection : end;
        const before = sel.$from.parent.textBetween(0, sel.$from.parentOffset, undefined, "￼");
        const insert = chipInsertText(tokens, before, { hasProse: proseOf(shown.current).trim() !== "", replacingSelection: replacing });
        if (insert === null) return;
        editor.chain().insertContentAt({ from: sel.from, to: sel.to }, piecesToNodes(parseLine(insert))).run();
      },
    }),
    [editor],
  );

  return (
    <ChipRepoContext.Provider value={repoId}>
      {/* data-value: the prompt as stored (chip tokens included), for tests and debugging. */}
      <div className="relative" data-testid="composer-prompt" data-value={value}>
        {value === "" && (
          <span aria-hidden className="pointer-events-none absolute top-3.5 left-4 text-sm leading-6 text-muted-foreground select-none">
            {placeholder}
          </span>
        )}
        <EditorContent editor={editor} />
      </div>
    </ChipRepoContext.Provider>
  );
}
